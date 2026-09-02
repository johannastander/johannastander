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
const POOL_ABI = ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"];

// Default set of sizes to test, as basis points of BORROW_AMOUNT (10000 = 1x):
// 0.25x, 0.5x, 1x, 2x, 5x, 10x. Override with SIZE_MULTIPLIERS_BPS in .env.
const DEFAULT_SIZE_MULTIPLIERS_BPS = [2500, 5000, 10000, 20000, 50000, 100000];

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

// Off-chain half of the bot: tests a range of loan sizes across both directions,
// picks whichever size+direction maximizes net profit (after Aave's flash loan
// premium - gas is roughly flat across sizes so it doesn't affect which size wins),
// prints what it found, and waits for confirmation before ever submitting a
// transaction. Run this on a loop / cron against a low-latency RPC if you want it
// to actually catch opportunities before they disappear - set AUTO_CONFIRM=true
// for that unattended case.
async function main() {
  const {
    ARBITRAGE_CONTRACT,
    ROUTER_A,
    ROUTER_B,
    TOKEN_BORROW,
    TOKEN_INTERMEDIATE,
    BORROW_AMOUNT,
    SLIPPAGE_BPS,
    SIZE_MULTIPLIERS_BPS,
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
  const baseAmount = BigInt(BORROW_AMOUNT);
  const sizeMultipliersBps = (SIZE_MULTIPLIERS_BPS
    ? SIZE_MULTIPLIERS_BPS.split(",").map((s) => Number(s.trim()))
    : DEFAULT_SIZE_MULTIPLIERS_BPS
  ).filter((bps) => bps > 0);

  const arb = await hre.ethers.getContractAt("FlashLoanArbitrage", ARBITRAGE_CONTRACT);
  const [signer] = await hre.ethers.getSigners();

  const poolAddress = await arb.POOL();
  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, signer);
  const premiumBps = await pool.FLASHLOAN_PREMIUM_TOTAL(); // e.g. 5n = 0.05%

  const borrowToken = await describeToken(TOKEN_BORROW, signer);
  const intermediateToken = await describeToken(TOKEN_INTERMEDIATE, signer);

  const routerA = new hre.ethers.Contract(ROUTER_A, ROUTER_ABI, signer);
  const routerB = new hre.ethers.Contract(ROUTER_B, ROUTER_ABI, signer);

  const directions = [
    { buy: ROUTER_A, sell: ROUTER_B, routerBuy: routerA, routerSell: routerB, label: "ROUTER_A -> ROUTER_B" },
    { buy: ROUTER_B, sell: ROUTER_A, routerBuy: routerB, routerSell: routerA, label: "ROUTER_B -> ROUTER_A" },
  ];

  async function quote(routerBuy, routerSell, amount) {
    const [, leg1Out] = await routerBuy.getAmountsOut(amount, [TOKEN_BORROW, TOKEN_INTERMEDIATE]);
    const [, leg2Out] = await routerSell.getAmountsOut(leg1Out, [TOKEN_INTERMEDIATE, TOKEN_BORROW]);
    const premium = (amount * premiumBps) / 10000n;
    const netProfit = leg2Out - amount - premium;
    return { amount, leg1Out, leg2Out, premium, netProfit };
  }

  console.log(
    `Scanning ${sizeMultipliersBps.length} sizes across 2 directions ` +
      `(base ${borrowToken.format(baseAmount)}, flash loan premium ${Number(premiumBps) / 100}%)\n`
  );

  let best = null;
  for (const dir of directions) {
    console.log(`${dir.label}:`);
    for (const bps of sizeMultipliersBps) {
      const amount = (baseAmount * BigInt(bps)) / 10000n;
      if (amount === 0n) continue;
      const result = await quote(dir.routerBuy, dir.routerSell, amount);
      const sign = result.netProfit >= 0n ? "+" : "";
      console.log(
        `  ${(bps / 10000).toFixed(2)}x (${borrowToken.format(amount)}): ` +
          `net ${sign}${borrowToken.format(result.netProfit)}`
      );
      if (result.netProfit > 0n && (!best || result.netProfit > best.netProfit)) {
        best = { ...dir, ...result };
      }
    }
  }

  if (!best) {
    console.log("\nNo profitable size/direction found right now. Exiting without submitting anything.");
    return;
  }

  // Leave headroom below the quoted net profit for price movement between the
  // quote and execution. Tune this margin for your asset/network.
  const minProfit = best.netProfit / 2n;
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

  console.log("\nBest opportunity found:");
  console.log(`  Direction:        ${best.label}`);
  console.log(`  Borrow size:      ${borrowToken.format(best.amount)}`);
  console.log(`  Expected back:    ${borrowToken.format(best.leg2Out)}`);
  console.log(`  Flash loan fee:   ${borrowToken.format(best.premium)}`);
  console.log(`  Net profit:       ${borrowToken.format(best.netProfit)}`);
  console.log(`  Min profit floor: ${borrowToken.format(minProfit)} (tx reverts below this)`);
  console.log(`  Slippage buffer:  ${slippageBps / 100}% per leg`);
  console.log(`  Contract:         ${ARBITRAGE_CONTRACT}`);
  console.log(
    `  Note: this quote can move before the transaction lands, and gas isn't included above -\n` +
      `  the minProfit floor and slippage buffer are what actually protect you, not this printed number.\n`
  );

  const proceed = await confirm("Submit this trade on-chain?");
  if (!proceed) {
    console.log("Declined. Exiting without submitting anything.");
    return;
  }

  const tx = await arb.executeArbitrage(TOKEN_BORROW, best.amount, params);
  console.log("Submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
