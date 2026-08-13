// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FlashLoanSimpleReceiverBase} from "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] calldata path)
        external
        view
        returns (uint[] memory amounts);
}

/// @notice Borrows a single asset via an Aave V3 flash loan, swaps it out and back
/// across two Uniswap V2-style routers, repays the loan + premium, and keeps the
/// difference. Reverts if the round trip isn't profitable, so it never leaves the
/// contract holding debt it can't cover.
contract FlashLoanArbitrage is FlashLoanSimpleReceiverBase, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error UnauthorizedCaller();
    error UntrustedInitiator();
    error InsufficientProfit(uint256 amountOwed, uint256 amountReceived);

    event ArbitrageExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 premium,
        uint256 profit
    );

    event ProfitWithdrawn(address indexed token, address indexed to, uint256 amount);

    struct ArbParams {
        address routerBuy;      // router where we swap borrowed asset -> intermediate token
        address routerSell;     // router where we swap intermediate token -> borrowed asset
        address intermediate;   // the token we route through
        uint256 minProfit;      // minimum profit (in borrowed asset) required, or the tx reverts
        uint256 amountOutMinBuy;
        uint256 amountOutMinSell;
        uint256 deadline;
    }

    constructor(address addressesProvider, address initialOwner)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(addressesProvider))
        Ownable(initialOwner)
    {}

    /// @notice Kicks off the flash loan. Only the owner can trigger an arbitrage attempt.
    function executeArbitrage(
        address asset,
        uint256 amount,
        ArbParams calldata params
    ) external onlyOwner nonReentrant {
        bytes memory data = abi.encode(params);
        POOL.flashLoanSimple(address(this), asset, amount, data, 0);
    }

    /// @dev Called back by the Aave Pool during the flash loan. Must not be callable directly.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(POOL)) revert UnauthorizedCaller();
        if (initiator != address(this)) revert UntrustedInitiator();

        ArbParams memory arb = abi.decode(params, (ArbParams));
        uint256 amountOwed = amount + premium;

        // Leg 1: borrowed asset -> intermediate token on routerBuy
        IERC20(asset).forceApprove(arb.routerBuy, amount);
        address[] memory pathBuy = new address[](2);
        pathBuy[0] = asset;
        pathBuy[1] = arb.intermediate;

        uint256[] memory boughtAmounts = IUniswapV2Router(arb.routerBuy).swapExactTokensForTokens(
            amount,
            arb.amountOutMinBuy,
            pathBuy,
            address(this),
            arb.deadline
        );
        uint256 intermediateReceived = boughtAmounts[boughtAmounts.length - 1];

        // Leg 2: intermediate token -> borrowed asset back on routerSell
        IERC20(arb.intermediate).forceApprove(arb.routerSell, intermediateReceived);
        address[] memory pathSell = new address[](2);
        pathSell[0] = arb.intermediate;
        pathSell[1] = asset;

        uint256[] memory soldAmounts = IUniswapV2Router(arb.routerSell).swapExactTokensForTokens(
            intermediateReceived,
            arb.amountOutMinSell,
            pathSell,
            address(this),
            arb.deadline
        );
        uint256 assetReceived = soldAmounts[soldAmounts.length - 1];

        // Must cover the loan + premium + the profit floor the caller demanded, or revert.
        // Reverting here unwinds the whole flash loan atomically - no funds are ever at risk.
        uint256 requiredBack = amountOwed + arb.minProfit;
        if (assetReceived < requiredBack) {
            revert InsufficientProfit(requiredBack, assetReceived);
        }

        // Repay the flash loan: Aave pulls `amountOwed` via allowance after this call returns.
        IERC20(asset).forceApprove(address(POOL), amountOwed);

        uint256 profit = assetReceived - amountOwed;
        emit ArbitrageExecuted(asset, amount, premium, profit);

        return true;
    }

    /// @notice View helper to check whether a round trip is currently profitable
    /// before spending gas on `executeArbitrage`. Not used on-chain by the contract itself.
    function quoteRoundTrip(
        address routerBuy,
        address routerSell,
        address asset,
        address intermediate,
        uint256 amountIn
    ) external view returns (uint256 amountOut) {
        address[] memory pathBuy = new address[](2);
        pathBuy[0] = asset;
        pathBuy[1] = intermediate;
        uint256[] memory outBuy = IUniswapV2Router(routerBuy).getAmountsOut(amountIn, pathBuy);

        address[] memory pathSell = new address[](2);
        pathSell[0] = intermediate;
        pathSell[1] = asset;
        uint256[] memory outSell = IUniswapV2Router(routerSell).getAmountsOut(
            outBuy[outBuy.length - 1],
            pathSell
        );

        amountOut = outSell[outSell.length - 1];
    }

    /// @notice Sweep any ERC20 left in the contract (accumulated profit) to the owner.
    function withdrawToken(address token, address to) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
        emit ProfitWithdrawn(token, to, balance);
    }

    /// @notice Sweep any stray native ETH sent to the contract.
    function withdrawETH(address payable to) external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        (bool success, ) = to.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
