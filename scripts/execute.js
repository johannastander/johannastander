const hre = require("hardhat");
require("dotenv").config();

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

  const arb = await hre.ethers.getContractAt("FlashLoanArbitrage", ARBITRAGE_CONTRACT);
  const amount = BigInt(BORROW_AMOUNT);

  // Check A -> B and B -> A round trips, take whichever is profitable (if any).
  const directions = [
    { buy: ROUTER_A, sell: ROUTER_B, label: "A->B" },
    { buy: ROUTER_B, sell: ROUTER_A, label: "B->A" },
  ];

  let best = null;
  for (const dir of directions) {
    const amountOut = await arb.quoteRoundTrip(
      dir.buy,
      dir.sell,
      TOKEN_BORROW,
      TOKEN_INTERMEDIATE,
      amount
    );
    console.log(`${dir.label}: borrow ${amount} -> back ${amountOut}`);
    if (amountOut > amount && (!best || amountOut > best.amountOut)) {
      best = { ...dir, amountOut };
    }
  }

  if (!best) {
    console.log("No profitable round trip found right now. Exiting.");
    return;
  }

  const grossProfit = best.amountOut - amount;
  console.log(`Best direction: ${best.label}, gross profit: ${grossProfit}`);

  // Leave headroom below the quoted profit for slippage/premium/price movement
  // between the quote and execution. Tune this margin for your asset/network.
  const minProfit = grossProfit / 2n;
  const deadline = Math.floor(Date.now() / 1000) + 300;

  const params = {
    routerBuy: best.buy,
    routerSell: best.sell,
    intermediate: TOKEN_INTERMEDIATE,
    minProfit,
    amountOutMinBuy: 0, // set a real slippage-protected minimum in production
    amountOutMinSell: 0, // set a real slippage-protected minimum in production
    deadline,
  };

  const tx = await arb.executeArbitrage(TOKEN_BORROW, amount, params);
  console.log("Submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
