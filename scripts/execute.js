const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
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

// Default set of sizes to test per pair, as basis points of that pair's
// baseAmount (10000 = 1x): 0.25x, 0.5x, 1x, 2x, 5x, 10x. Override with
// SIZE_MULTIPLIERS_BPS in .env.
const DEFAULT_SIZE_MULTIPLIERS_BPS = [2500, 5000, 10000, 20000, 50000, 100000];
// How many of the top grossly-profitable candidates (across ALL pairs and
// router combos) to gas-check before giving up.
const MAX_CANDIDATES_TO_GAS_CHECK = 3;

function applySlippage(amount, slippageBps) {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

function loadMarketsConfig(configPath) {
  const resolved = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(config.routers) || config.routers.length < 2) {
    throw new Error(`${resolved}: need at least 2 entries under "routers"`);
  }
  if (!Array.isArray(config.pairs) || config.pairs.length === 0) {
    throw new Error(`${resolved}: need at least 1 entry under "pairs"`);
  }
  return config;
}

// Best-effort token metadata for display only - falls back to raw units/address
// if a token doesn't implement decimals()/symbol() (some don't). Memoized since
// the same token can appear across multiple pairs.
function makeTokenDescriber(signer) {
  const cache = new Map();
  return async function describeToken(address) {
    if (cache.has(address)) return cache.get(address);
    const token = new hre.ethers.Contract(address, ERC20_ABI, signer);
    let described;
    try {
      const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
      described = {
        address,
        decimals: Number(decimals),
        symbol,
        format: (amount) => `${hre.ethers.formatUnits(amount, decimals)} ${symbol}`,
      };
    } catch {
      described = { address, decimals: 0, symbol: address, format: (amount) => `${amount} (raw units, ${address})` };
    }
    cache.set(address, described);
    return described;
  };
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

// Off-chain half of the bot: scans every router combination across every pair
// in the markets config, at a range of sizes, and picks whichever candidate
// maximizes net profit after Aave's flash loan premium AND real gas cost
// (converted into that candidate's own borrow token terms). Prints what it
// found and waits for confirmation before ever submitting a transaction. Run
// this on a loop / cron against a low-latency RPC if you want it to actually
// catch opportunities before they disappear - set AUTO_CONFIRM=true for that
// unattended case.
async function main() {
  const {
    ARBITRAGE_CONTRACT,
    MARKETS_CONFIG,
    SLIPPAGE_BPS,
    SIZE_MULTIPLIERS_BPS,
    NATIVE_WRAPPED_TOKEN,
    GAS_BUFFER_BPS,
    DEFAULT_GAS_LIMIT,
  } = process.env;

  for (const [name, value] of Object.entries({ ARBITRAGE_CONTRACT, NATIVE_WRAPPED_TOKEN })) {
    if (!value) throw new Error(`Set ${name} in .env before running this script`);
  }

  const config = loadMarketsConfig(MARKETS_CONFIG || "./markets.config.json");
  const slippageBps = Number(SLIPPAGE_BPS || 50); // default 0.5%
  const gasBufferBps = BigInt(GAS_BUFFER_BPS || 2000); // default 20% safety margin
  const defaultGasLimit = BigInt(DEFAULT_GAS_LIMIT || 500000);
  const sizeMultipliersBps = (SIZE_MULTIPLIERS_BPS
    ? SIZE_MULTIPLIERS_BPS.split(",").map((s) => Number(s.trim()))
    : DEFAULT_SIZE_MULTIPLIERS_BPS
  ).filter((bps) => bps > 0);

  const arb = await hre.ethers.getContractAt("FlashLoanArbitrage", ARBITRAGE_CONTRACT);
  const [signer] = await hre.ethers.getSigners();
  const describeToken = makeTokenDescriber(signer);

  const poolAddress = await arb.POOL();
  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, signer);
  const premiumBps = await pool.FLASHLOAN_PREMIUM_TOTAL(); // e.g. 5n = 0.05%

  const routers = config.routers.map((r) => ({
    ...r,
    contract: new hre.ethers.Contract(r.address, ROUTER_ABI, signer),
  }));
  const routerCombos = [];
  for (const buy of routers) {
    for (const sell of routers) {
      if (buy.address.toLowerCase() === sell.address.toLowerCase()) continue;
      routerCombos.push({ buy, sell, label: `${buy.name} -> ${sell.name}` });
    }
  }

  const totalQuotes = config.pairs.length * routerCombos.length * sizeMultipliersBps.length;
  console.log(
    `Scanning ${config.pairs.length} pair(s) x ${routerCombos.length} router combo(s) x ` +
      `${sizeMultipliersBps.length} size(s) = ${totalQuotes} candidates ` +
      `(flash loan premium ${Number(premiumBps) / 100}%)\n`
  );

  async function quote(routerBuy, routerSell, tokenBorrow, tokenIntermediate, amount) {
    const [, leg1Out] = await routerBuy.getAmountsOut(amount, [tokenBorrow, tokenIntermediate]);
    const [, leg2Out] = await routerSell.getAmountsOut(leg1Out, [tokenIntermediate, tokenBorrow]);
    const premium = (amount * premiumBps) / 10000n;
    const grossNetProfit = leg2Out - amount - premium; // excludes gas
    return { amount, leg1Out, leg2Out, premium, grossNetProfit };
  }

  const candidates = [];
  for (const pair of config.pairs) {
    const borrowToken = await describeToken(pair.borrowToken.address);
    const intermediateToken = await describeToken(pair.intermediateToken.address);
    const baseAmount = BigInt(pair.borrowToken.baseAmount);

    console.log(`${pair.label}:`);
    for (const combo of routerCombos) {
      for (const bps of sizeMultipliersBps) {
        const amount = (baseAmount * BigInt(bps)) / 10000n;
        if (amount === 0n) continue;
        let result;
        try {
          result = await quote(
            combo.buy.contract,
            combo.sell.contract,
            pair.borrowToken.address,
            pair.intermediateToken.address,
            amount
          );
        } catch {
          // No liquidity/route for this combo at this size - skip rather than crash the scan.
          continue;
        }
        const sign = result.grossNetProfit >= 0n ? "+" : "";
        console.log(
          `  [${combo.label}] ${(bps / 10000).toFixed(2)}x (${borrowToken.format(amount)}): ` +
            `gross ${sign}${borrowToken.format(result.grossNetProfit)} (pre-gas)`
        );
        if (result.grossNetProfit > 0n) {
          candidates.push({
            ...combo,
            ...result,
            pairLabel: pair.label,
            tokenBorrow: pair.borrowToken.address,
            tokenIntermediate: pair.intermediateToken.address,
            borrowToken,
            intermediateToken,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    console.log("\nNo profitable round trip found right now (even before gas). Exiting.");
    return;
  }

  candidates.sort((a, b) => (b.grossNetProfit > a.grossNetProfit ? 1 : -1));

  // Gas cost isn't comparable across pairs in raw units (different tokens), so
  // it can't be sorted on until it's converted per-candidate below - hence the
  // two-pass approach: rank on gross profit first, then gas-check the leaders.
  const isBorrowTokenNative = (tokenAddress) => tokenAddress.toLowerCase() === NATIVE_WRAPPED_TOKEN.toLowerCase();

  async function nativeToBorrowToken(weiAmount, candidate) {
    if (isBorrowTokenNative(candidate.tokenBorrow)) return weiAmount;
    for (const router of [candidate.buy.contract, candidate.sell.contract]) {
      try {
        const [, out] = await router.getAmountsOut(weiAmount, [NATIVE_WRAPPED_TOKEN, candidate.tokenBorrow]);
        return out;
      } catch {
        // try the next router
      }
    }
    throw new Error(
      `Could not price gas cost in ${candidate.borrowToken.symbol}: no ${NATIVE_WRAPPED_TOKEN} -> ` +
        `${candidate.tokenBorrow} route on either router in this combo. Add that liquidity route or ` +
        `check NATIVE_WRAPPED_TOKEN is correct for this chain.`
    );
  }

  const feeData = await hre.ethers.provider.getFeeData();
  const gasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
  console.log(`\nCurrent gas price: ${hre.ethers.formatUnits(gasPriceWei, "gwei")} gwei`);

  let winner = null;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_TO_GAS_CHECK)) {
    const estimationParams = {
      routerBuy: candidate.buy.address,
      routerSell: candidate.sell.address,
      intermediate: candidate.tokenIntermediate,
      minProfit: 0,
      amountOutMinBuy: 0,
      amountOutMinSell: 0,
      deadline: Math.floor(Date.now() / 1000) + 300,
    };

    let gasUnits;
    try {
      gasUnits = await arb.executeArbitrage.estimateGas(candidate.tokenBorrow, candidate.amount, estimationParams);
    } catch (error) {
      console.log(
        `  Gas estimate failed for [${candidate.pairLabel}] ${candidate.label} @ ` +
          `${candidate.borrowToken.format(candidate.amount)} (${error.shortMessage || error.message}); ` +
          `using DEFAULT_GAS_LIMIT=${defaultGasLimit} instead.`
      );
      gasUnits = defaultGasLimit;
    }

    const gasCostWei = (gasUnits * gasPriceWei * (10000n + gasBufferBps)) / 10000n;
    const gasCostInBorrowToken = await nativeToBorrowToken(gasCostWei, candidate);
    const netProfit = candidate.grossNetProfit - gasCostInBorrowToken;

    console.log(
      `  Checked [${candidate.pairLabel}] ${candidate.label} @ ${candidate.borrowToken.format(candidate.amount)}: ` +
        `gas ~${gasUnits} units (${candidate.borrowToken.format(gasCostInBorrowToken)}) -> ` +
        `net ${netProfit >= 0n ? "+" : ""}${candidate.borrowToken.format(netProfit)}`
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
    routerBuy: winner.buy.address,
    routerSell: winner.sell.address,
    intermediate: winner.tokenIntermediate,
    minProfit,
    amountOutMinBuy: applySlippage(winner.leg1Out, slippageBps),
    amountOutMinSell: applySlippage(winner.leg2Out, slippageBps),
    deadline,
  };

  console.log("\nBest opportunity found (after gas):");
  console.log(`  Pair:             ${winner.pairLabel}`);
  console.log(`  Direction:        ${winner.label}`);
  console.log(`  Borrow size:      ${winner.borrowToken.format(winner.amount)}`);
  console.log(`  Expected back:    ${winner.borrowToken.format(winner.leg2Out)}`);
  console.log(`  Flash loan fee:   ${winner.borrowToken.format(winner.premium)}`);
  console.log(
    `  Est. gas cost:    ${winner.borrowToken.format(winner.gasCostInBorrowToken)} ` +
      `(${winner.gasUnits} units, ${Number(gasBufferBps) / 100}% buffer)`
  );
  console.log(`  Net profit:       ${winner.borrowToken.format(winner.netProfit)}`);
  console.log(`  Min profit floor: ${winner.borrowToken.format(minProfit)} (tx reverts below this)`);
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

  const tx = await arb.executeArbitrage(winner.tokenBorrow, winner.amount, params);
  console.log("Submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
