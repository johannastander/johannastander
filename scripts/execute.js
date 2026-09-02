const hre = require("hardhat");
require("dotenv").config();

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
];

function applySlippage(amount, slippageBps) {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

// Off-chain half of the bot: checks whether a round trip between ROUTER_A and
// ROUTER_B is currently profitable, and only fires the on-chain flash loan if so.
// Run this on a loop / cron against a low-latency RPC if you want it to actually
// catch opportunities before they disappear.
async function main() {
  const {
    ARBITRAGE_CONTRACT,
    ROUTER_A,
    ROUTER_B,
    TOKEN_BORROW,
    TOKEN_INTERMEDIATE,
    BORROW_AMOUNT,
    SLIPPAGE_BPS,
  } = process.env;

  for (const [name, value] of Object.entries({
    ARBITRAGE_CONTRACT,
    ROUTER_A,
    ROUTER_B,
    TOKEN_BORROW,
    TOKEN_INTERMEDIATE,
    BORROW_AMOUNT,
  })) {
    if (!value) throw new Error(`Set ${name} in .env before running this script`);
  }

  const slippageBps = Number(SLIPPAGE_BPS || 50); // default 0.5%
  const arb = await hre.ethers.getContractAt("FlashLoanArbitrage", ARBITRAGE_CONTRACT);
  const [signer] = await hre.ethers.getSigners();
  const amount = BigInt(BORROW_AMOUNT);

  const routerA = new hre.ethers.Contract(ROUTER_A, ROUTER_ABI, signer);
  const routerB = new hre.ethers.Contract(ROUTER_B, ROUTER_ABI, signer);

  // Quote both legs of both directions independently (rather than trusting the
  // contract's single-number quoteRoundTrip) so we have the per-leg amounts
  // needed to compute real slippage-protected minimums below.
  async function quoteDirection(routerBuy, routerSell) {
    const [, leg1Out] = await routerBuy.getAmountsOut(amount, [TOKEN_BORROW, TOKEN_INTERMEDIATE]);
    const [, leg2Out] = await routerSell.getAmountsOut(leg1Out, [TOKEN_INTERMEDIATE, TOKEN_BORROW]);
    return { leg1Out, leg2Out };
  }

  const directions = [
    { buy: ROUTER_A, sell: ROUTER_B, routerBuy: routerA, routerSell: routerB, label: "A->B" },
    { buy: ROUTER_B, sell: ROUTER_A, routerBuy: routerB, routerSell: routerA, label: "B->A" },
  ];

  let best = null;
  for (const dir of directions) {
    const { leg1Out, leg2Out } = await quoteDirection(dir.routerBuy, dir.routerSell);
    console.log(`${dir.label}: borrow ${amount} -> back ${leg2Out}`);
    if (leg2Out > amount && (!best || leg2Out > best.amountOut)) {
      best = { ...dir, amountOut: leg2Out, leg1Out, leg2Out };
    }
  }

  if (!best) {
    console.log("No profitable round trip found right now. Exiting.");
    return;
  }

  const grossProfit = best.amountOut - amount;
  console.log(`Best direction: ${best.label}, gross profit: ${grossProfit}`);

  // Leave headroom below the quoted profit for the flash loan premium and price
  // movement between the quote and execution. Tune this margin for your asset/network.
  const minProfit = grossProfit / 2n;
  const deadline = Math.floor(Date.now() / 1000) + 300;

  const params = {
    routerBuy: best.buy,
    routerSell: best.sell,
    intermediate: TOKEN_INTERMEDIATE,
    minProfit,
    amountOutMinBuy: applySlippage(best.leg1Out, slippageBps),
    amountOutMinSell: applySlippage(best.leg2Out, slippageBps),
    deadline,
  };

  console.log(
    `Slippage tolerance: ${slippageBps / 100}% | minOutBuy: ${params.amountOutMinBuy} | minOutSell: ${params.amountOutMinSell}`
  );

  const tx = await arb.executeArbitrage(TOKEN_BORROW, amount, params);
  console.log("Submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
