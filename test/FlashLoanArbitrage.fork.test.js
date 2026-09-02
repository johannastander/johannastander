const { expect } = require("chai");
const hre = require("hardhat");

// Full end-to-end test against real mainnet contracts via Hardhat's forking mode:
// Aave V3's real Pool, and real Uniswap V2 / Sushiswap routers and pairs. Nothing
// here is mocked, so this is the closest thing to a dry run without real capital.
//
// Requires RPC_URL in .env to point at an archive-capable mainnet RPC (Alchemy/
// Infura free tier works). Skipped automatically if RPC_URL isn't set.
//
// What it proves:
//   1. A manufactured price gap between two DEXs is actually captured end to end
//      (flash loan -> swap -> swap -> repay -> profit lands in the contract).
//   2. When there's no gap, the trade reverts with InsufficientProfit instead of
//      silently losing money - the safety property the whole design depends on.

const AAVE_ADDRESSES_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9";
const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHISWAP_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9f";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const WETH_ABI = [...ERC20_ABI, "function deposit() payable"];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
];

const describeOrSkip = process.env.RPC_URL ? describe : describe.skip;

describeOrSkip("FlashLoanArbitrage (mainnet fork)", function () {
  this.timeout(120000);

  async function deployArb() {
    const [deployer] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("FlashLoanArbitrage");
    const arb = await Factory.deploy(AAVE_ADDRESSES_PROVIDER, deployer.address);
    await arb.waitForDeployment();
    return { arb, deployer };
  }

  // Manufactures a real price gap: wraps a large amount of ETH and dumps it into
  // the Uniswap WETH/USDC pool, which pushes WETH's price down on Uniswap relative
  // to Sushiswap. If this doesn't produce a profitable quote in the test below,
  // the pool at your fork's current block is deeper than expected - increase
  // `dumpAmountEth`.
  async function skewUniswapPool(signer, dumpAmountEth) {
    const weth = new hre.ethers.Contract(WETH, WETH_ABI, signer);
    await weth.deposit({ value: hre.ethers.parseEther(String(dumpAmountEth)) });

    const uniRouter = new hre.ethers.Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, signer);
    await weth.approve(UNISWAP_V2_ROUTER, hre.ethers.MaxUint256);

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await uniRouter.swapExactTokensForTokens(
      hre.ethers.parseEther(String(dumpAmountEth)),
      0,
      [WETH, USDC],
      await signer.getAddress(),
      deadline
    );
  }

  it("captures a manufactured price gap and lands profit in the contract", async function () {
    const { arb, deployer } = await deployArb();

    // Skew Uniswap's WETH/USDC price down relative to Sushiswap's.
    await skewUniswapPool(deployer, 3000);

    const borrowAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC

    const quote = await arb.quoteRoundTrip(
      UNISWAP_V2_ROUTER, // buy WETH cheap here
      SUSHISWAP_ROUTER, // sell WETH at the normal price here
      USDC,
      WETH,
      borrowAmount
    );
    console.log(`Quoted round trip: borrow ${borrowAmount} -> back ${quote}`);
    expect(quote).to.be.gt(borrowAmount);

    const uniRouter = new hre.ethers.Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, deployer);
    const sushiRouter = new hre.ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, deployer);
    const [, leg1Out] = await uniRouter.getAmountsOut(borrowAmount, [USDC, WETH]);
    const [, leg2Out] = await sushiRouter.getAmountsOut(leg1Out, [WETH, USDC]);

    const grossProfit = leg2Out - borrowAmount;
    const minProfit = grossProfit / 2n; // leave headroom, same as scripts/execute.js
    const slippageBps = 50n;
    const applySlippage = (amt) => (amt * (10000n - slippageBps)) / 10000n;

    const params = {
      routerBuy: UNISWAP_V2_ROUTER,
      routerSell: SUSHISWAP_ROUTER,
      intermediate: WETH,
      minProfit,
      amountOutMinBuy: applySlippage(leg1Out),
      amountOutMinSell: applySlippage(leg2Out),
      deadline: Math.floor(Date.now() / 1000) + 3600,
    };

    const usdc = new hre.ethers.Contract(USDC, ERC20_ABI, deployer);
    const balanceBefore = await usdc.balanceOf(await arb.getAddress());

    const tx = await arb.executeArbitrage(USDC, borrowAmount, params);
    const receipt = await tx.wait();

    const event = receipt.logs
      .map((log) => {
        try {
          return arb.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "ArbitrageExecuted");

    expect(event).to.not.be.undefined;
    const emittedProfit = event.args.profit;
    console.log(`Realized profit: ${emittedProfit} USDC units`);
    expect(emittedProfit).to.be.gt(0n);

    const balanceAfter = await usdc.balanceOf(await arb.getAddress());
    expect(balanceAfter - balanceBefore).to.equal(emittedProfit);

    // Owner can withdraw the realized profit.
    await arb.withdrawToken(USDC, deployer.address);
    expect(await usdc.balanceOf(await arb.getAddress())).to.equal(0n);
  });

  it("reverts with InsufficientProfit when there is no real price gap", async function () {
    const { arb } = await deployArb();

    const borrowAmount = hre.ethers.parseUnits("50000", 6);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // Same router on both legs: buy and sell at (approximately) the same price,
    // so the round trip cannot cover the flash loan premium. This must revert -
    // it's the core safety property the whole contract depends on.
    const params = {
      routerBuy: UNISWAP_V2_ROUTER,
      routerSell: UNISWAP_V2_ROUTER,
      intermediate: WETH,
      minProfit: 0,
      amountOutMinBuy: 0,
      amountOutMinSell: 0,
      deadline,
    };

    await expect(
      arb.executeArbitrage(USDC, borrowAmount, params)
    ).to.be.revertedWithCustomError(arb, "InsufficientProfit");
  });
});
