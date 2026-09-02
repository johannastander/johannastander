const hre = require("hardhat");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
require("dotenv").config();

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function applySlippage(amount, slippageBps) {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

// Best-effort token metadata for display only - falls back to raw units/address
// if a token doesn't implement decimals()/symbol() (some don't).
async function describeToken(address, signer) {
  const token = new hre.ethers.Contract(address, ERC20_ABI, signer);
  try {
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    return {
      decimals: Number(decimals),
      symbol,
      format: (amount) => `${hre.ethers.formatUnits(amount, decimals)} ${symbol}`,
    };
  } catch {
    return { decimals: 0, symbol: address, format: (amount) => `${amount} (raw units, ${address})` };
  }
}

async function confirm(question) {
  // AUTO_CONFIRM=true skips the prompt for unattended/cron runs. Default is to
  // ask - this script is meant to find an opportunity, show you the numbers,
  // and wait for a yes before ever submitting a transaction.
  if (process.env.AUTO_CONFIRM === "true") {
    console.log(`${question} [auto-confirmed via AUTO_CONFIRM=true]`);
    return true;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} (y/N): `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

// Off-chain half of the bot: checks whether a round trip between ROUTER_A and
// ROUTER_B is currently profitable, prints what it found, and waits for
// confirmation before ever submitting a transaction. Run this on a loop / cron
// against a low-latency RPC if you want it to actually catch opportunities
// before they disappear - set AUTO_CONFIRM=true for that unattended case.
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

  const borrowToken = await describeToken(TOKEN_BORROW, signer);
  const intermediateToken = await describeToken(TOKEN_INTERMEDIATE, signer);

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
    { buy: ROUTER_A, sell: ROUTER_B, routerBuy: routerA, routerSell: routerB, label: "ROUTER_A -> ROUTER_B" },
    { buy: ROUTER_B, sell: ROUTER_A, routerBuy: routerB, routerSell: routerA, label: "ROUTER_B -> ROUTER_A" },
  ];

  console.log(`Scanning for an arbitrage opportunity: borrow ${borrowToken.format(amount)}\n`);

  let best = null;
  for (const dir of directions) {
    const { leg1Out, leg2Out } = await quoteDirection(dir.routerBuy, dir.routerSell);
    const pnl = leg2Out - amount;
    const sign = pnl >= 0n ? "+" : "";
    console.log(
      `  ${dir.label}: ${borrowToken.format(amount)} -> ${intermediateToken.format(leg1Out)} -> ` +
        `${borrowToken.format(leg2Out)}  (${sign}${borrowToken.format(pnl)})`
    );
    if (leg2Out > amount && (!best || leg2Out > best.amountOut)) {
      best = { ...dir, amountOut: leg2Out, leg1Out, leg2Out };
    }
  }

  if (!best) {
    console.log("\nNo profitable round trip found right now. Exiting without submitting anything.");
    return;
  }

  const grossProfit = best.amountOut - amount;
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

  console.log("\nOpportunity found:");
  console.log(`  Direction:        ${best.label}`);
  console.log(`  Borrow:           ${borrowToken.format(amount)}`);
  console.log(`  Expected back:    ${borrowToken.format(best.amountOut)}`);
  console.log(`  Gross profit:     ${borrowToken.format(grossProfit)}`);
  console.log(`  Min profit floor: ${borrowToken.format(minProfit)} (tx reverts below this)`);
  console.log(`  Slippage buffer:  ${slippageBps / 100}% per leg`);
  console.log(`  Contract:         ${ARBITRAGE_CONTRACT}`);
  console.log(
    `  Note: this quote can move before the transaction lands - the minProfit floor and slippage\n` +
      `  buffer above are what actually protect you, not this printed number.\n`
  );

  const proceed = await confirm("Submit this trade on-chain?");
  if (!proceed) {
    console.log("Declined. Exiting without submitting anything.");
    return;
  }

  const tx = await arb.executeArbitrage(TOKEN_BORROW, amount, params);
  console.log("Submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
