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
// How many of the top grossly-profitable candidates to gas-check before giving up.
const MAX_CANDIDATES_TO_GAS_CHECK = 3;

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
// picks whichever size+direction maximizes net profit after Aave's flash loan
// premium AND real gas cost (converted into the borrow token's terms), prints
// what it found, and waits for confirmation before ever submitting a
// transaction. Run this on a loop / cron against a low-latency RPC if you want
// it to actually catch opportunities before they disappear - set
// AUTO_CONFIRM=true for that unattended case.
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
    NATIVE_WRAPPED_TOKEN,
    GAS_BUFFER_BPS,
    DEFAULT_GAS_LIMIT,
  } = process.env;

  for (const [name, value] of Object.entries({
    ARBITRAGE_CONTRACT,
    ROUTER_A,
    ROUTER_B,
    TOKEN_BORROW,
    TOKEN_INTERMEDIATE,
    BORROW_AMOUNT,
    NATIVE_WRAPPED_TOKEN,
  })) {
    if (!value) throw new Error(`Set ${name} in .env before running this script`);
  }

  const slippageBps = Number(SLIPPAGE_BPS || 50); // default 0.5%
  const gasBufferBps = BigInt(GAS_BUFFER_BPS || 2000); // default 20% safety margin
  const defaultGasLimit = BigInt(DEFAULT_GAS_LIMIT || 500000);
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
  const isBorrowTokenNative = TOKEN_BORROW.toLowerCase() === NATIVE_WRAPPED_TOKEN.toLowerCase();

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
    const grossNetProfit = leg2Out - amount - premium; // excludes gas
    return { amount, leg1Out, leg2Out, premium, grossNetProfit };
  }

  // Converts a native-currency wei amount (what gas actually costs) into the
  // borrow token's units, by quoting NATIVE_WRAPPED_TOKEN -> TOKEN_BORROW on
  // whichever of the two routers has that pool. Throws if neither does - we'd
  // rather stop than silently treat gas as free.
  async function nativeToBorrowToken(weiAmount, candidateRouters) {
    if (isBorrowTokenNative) return weiAmount;
    for (const router of candidateRouters) {
      try {
        const [, out] = await router.getAmountsOut(weiAmount, [NATIVE_WRAPPED_TOKEN, TOKEN_BORROW]);
        return out;
      } catch {
        // try the next router
      }
    }
    throw new Error(
      `Could not price gas cost in ${borrowToken.symbol}: no ${NATIVE_WRAPPED_TOKEN} -> ${TOKEN_BORROW} ` +
        `route on either router. Set NATIVE_WRAPPED_TOKEN to this chain's wrapped native asset, or route ` +
        `through a pair that has that liquidity.`
    );
  }

  console.log(
    `Scanning ${sizeMultipliersBps.length} sizes across 2 directions ` +
      `(base ${borrowToken.format(baseAmount)}, flash loan premium ${Number(premiumBps) / 100}%)\n`
  );

  const candidates = [];
  for (const dir of directions) {
    console.log(`${dir.label}:`);
    for (const bps of sizeMultipliersBps) {
      const amount = (baseAmount * BigInt(bps)) / 10000n;
      if (amount === 0n) continue;
      const result = await quote(dir.routerBuy, dir.routerSell, amount);
      const sign = result.grossNetProfit >= 0n ? "+" : "";
      console.log(
        `  ${(bps / 10000).toFixed(2)}x (${borrowToken.format(amount)}): ` +
          `gross ${sign}${borrowToken.format(result.grossNetProfit)} (pre-gas)`
      );
      if (result.grossNetProfit > 0n) {
        candidates.push({ ...dir, ...result });
      }
    }
  }

  if (candidates.length === 0) {
    console.log("\nNo profitable round trip found right now (even before gas). Exiting.");
    return;
  }

  candidates.sort((a, b) => (b.grossNetProfit > a.grossNetProfit ? 1 : -1));

  const feeData = await hre.ethers.provider.getFeeData();
  const gasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
  console.log(`\nCurrent gas price: ${hre.ethers.formatUnits(gasPriceWei, "gwei")} gwei`);

  let winner = null;
  const checked = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_TO_GAS_CHECK)) {
    const estimationParams = {
      routerBuy: candidate.buy,
      routerSell: candidate.sell,
      intermediate: TOKEN_INTERMEDIATE,
      minProfit: 0,
      amountOutMinBuy: 0,
      amountOutMinSell: 0,
      deadline: Math.floor(Date.now() / 1000) + 300,
    };

    let gasUnits;
    try {
      gasUnits = await arb.executeArbitrage.estimateGas(TOKEN_BORROW, candidate.amount, estimationParams);
    } catch (error) {
      console.log(
        `  Gas estimate failed for ${candidate.label} @ ${borrowToken.format(candidate.amount)} ` +
          `(${error.shortMessage || error.message}); using DEFAULT_GAS_LIMIT=${defaultGasLimit} instead.`
      );
      gasUnits = defaultGasLimit;
    }

    const gasCostWei = (gasUnits * gasPriceWei * (10000n + gasBufferBps)) / 10000n;
    const gasCostInBorrowToken = await nativeToBorrowToken(gasCostWei, [candidate.routerBuy, candidate.routerSell]);
    const netProfit = candidate.grossNetProfit - gasCostInBorrowToken;

    checked.push({ ...candidate, gasUnits, gasCostWei, gasCostInBorrowToken, netProfit });
    console.log(
      `  Checked ${candidate.label} @ ${borrowToken.format(candidate.amount)}: ` +
        `gas ~${gasUnits} units (${borrowToken.format(gasCostInBorrowToken)}) -> ` +
        `net ${netProfit >= 0n ? "+" : ""}${borrowToken.format(netProfit)}`
    );

    if (netProfit > 0n && (!winner || netProfit > winner.netProfit)) {
      winner = { ...candidate, gasUnits, gasCostWei, gasCostInBorrowToken, netProfit };
    }
  }

  if (!winner) {
    console.log(
      "\nNothing clears gas costs right now - the best pre-gas candidates don't survive real gas price. Exiting."
    );
    return;
  }

  // Leave headroom below the real (post-gas) net profit for price movement
  // between the quote and execution. Tune this margin for your asset/network.
  const minProfit = winner.netProfit / 2n;
  const deadline = Math.floor(Date.now() / 1000) + 300;

  const params = {
    routerBuy: winner.buy,
    routerSell: winner.sell,
    intermediate: TOKEN_INTERMEDIATE,
    minProfit,
    amountOutMinBuy: applySlippage(winner.leg1Out, slippageBps),
    amountOutMinSell: applySlippage(winner.leg2Out, slippageBps),
    deadline,
  };

  console.log("\nBest opportunity found (after gas):");
  console.log(`  Direction:        ${winner.label}`);
  console.log(`  Borrow size:      ${borrowToken.format(winner.amount)}`);
  console.log(`  Expected back:    ${borrowToken.format(winner.leg2Out)}`);
  console.log(`  Flash loan fee:   ${borrowToken.format(winner.premium)}`);
  console.log(`  Est. gas cost:    ${borrowToken.format(winner.gasCostInBorrowToken)} (${winner.gasUnits} units, ${Number(gasBufferBps) / 100}% buffer)`);
  console.log(`  Net profit:       ${borrowToken.format(winner.netProfit)}`);
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

  const tx = await arb.executeArbitrage(TOKEN_BORROW, winner.amount, params);
  console.log("Submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
