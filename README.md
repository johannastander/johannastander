# Flash Loan Arbitrage (Aave V3 + Uniswap V2-style DEXs)

Borrows a token via an [Aave V3](https://docs.aave.com/developers/guides/flash-loans) flash loan,
swaps it out and back across two Uniswap V2-style routers, repays the loan + premium, and keeps
the spread. The trade only settles if it's profitable — if the round trip doesn't cover the loan,
the whole transaction reverts and nothing happens (no funds are ever put at risk beyond gas).

## How it works

1. `executeArbitrage` (owner-only) requests a flash loan from Aave's `Pool`.
2. Aave calls back into `executeOperation` with the borrowed funds.
3. The contract swaps `asset -> intermediate` on `routerBuy`, then `intermediate -> asset` on
   `routerSell`.
4. If the amount received back is less than `amount + premium + minProfit`, the call reverts and
   the entire flash loan unwinds atomically.
5. Otherwise it approves Aave to pull `amount + premium` and keeps the difference as profit.

## Project layout

```
contracts/FlashLoanArbitrage.sol   the on-chain contract
scripts/deploy.js                  deploys the contract
scripts/execute.js                 off-chain: scans routers/pairs, fires the trade if profitable
markets.config.json                routers and token pairs to scan
test/FlashLoanArbitrage.test.js    smoke tests (owner checks, access control)
.env.example                       config template
```

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC_URL, PRIVATE_KEY, AAVE_ADDRESSES_PROVIDER
npx hardhat compile
```

Edit `markets.config.json` to list the routers and token pairs you want scanned — see
[Scanning multiple pairs](#scanning-multiple-pairs) below.

**Start on a testnet.** Use Sepolia (or another network with an Aave V3 deployment and DEX
liquidity) before touching mainnet funds. Aave's deployed addresses per network are listed at
https://aave.com/docs/resources/addresses.

Deploy:

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

Copy the deployed address into `ARBITRAGE_CONTRACT` in `.env`.

Run the bot once:

```bash
npx hardhat run scripts/execute.js --network sepolia
```

`scripts/execute.js` runs in two passes:

1. **Scan**: for every router combination × token pair × loan size in `markets.config.json`,
   quotes the round trip and computes gross profit after Aave's flash loan premium.
2. **Gas check**: takes the top few grossly-profitable candidates (across *all* pairs, not just
   the leading pair), runs a real `estimateGas` against each, prices that gas cost in that
   candidate's own borrow token terms via `NATIVE_WRAPPED_TOKEN` (so a USDC-denominated trade's
   profit is compared against gas paid in ETH/MATIC/etc. correctly, and a DAI-denominated one
   against its own conversion), and picks whichever candidate is still profitable net of that —
   not just gross.

If a real net-profitable trade survives both passes, it prints what it found — pair, direction,
size, flash loan fee, gas cost, net profit — and **asks for confirmation before submitting
anything on-chain**. Nothing gets sent until you type `y`. For unattended/cron use, set
`AUTO_CONFIRM=true` in `.env` to skip the prompt and submit automatically once a trade clears your
`SLIPPAGE_BPS` and profit floor.

There's no "right" loan size in general — it's bounded above by Aave's available liquidity for
that asset and by DEX pool depth (bigger loans move the pool price against you on both legs, so
profit peaks at some size and then falls, often turning negative). Gas is roughly flat regardless
of size, so it doesn't change which size is optimal, but it does set a profit floor below which
even the "best" size isn't worth submitting — which is exactly why the gas check runs on the
already-picked best candidates instead of every single one: gas doesn't discriminate between
sizes, it just decides whether the winner is worth submitting at all.

For it to actually catch real opportunities you'd run it on a loop against a fast RPC — the
version here is a single-shot check, not a production keeper loop.

### Scanning multiple pairs

`markets.config.json` lists any number of routers and any number of token pairs:

```json
{
  "routers": [
    { "name": "UniswapV2", "address": "0x..." },
    { "name": "Sushiswap", "address": "0x..." }
  ],
  "pairs": [
    {
      "label": "USDC/WETH",
      "borrowToken": { "address": "0x...", "baseAmount": "50000000000" },
      "intermediateToken": { "address": "0x..." }
    }
  ]
}
```

`execute.js` tries every ordered pair of *distinct* routers (so 3 routers means 6 combinations,
not 2) against every pair in the list. `baseAmount` is per pair, in that pair's borrow token's
smallest unit, since a sensible size for USDC (6 decimals) and WETH (18 decimals) differ by
orders of magnitude — `SIZE_MULTIPLIERS_BPS` then scales each pair's own `baseAmount`, same as
before. Point `MARKETS_CONFIG` in `.env` at a different file if you want multiple configs (e.g.
one per chain).

Total quotes per run is `pairs × router combos × sizes` — each one is a read-only `getAmountsOut`
call, so it's cheap, but a large config against a rate-limited public RPC will be slow. Keep the
list to routers/pairs you actually have liquidity data for; a private/paid RPC handles a larger
scan fine.

## Things you need to fix before this touches real money

This code is a working starting point, not a profitable bot out of the box. In particular:

- **MEV / front-running.** Public mempool transactions that reveal a profitable arbitrage can be
  copied or front-run by other bots/searchers. Consider a private relay (e.g. Flashbots Protect)
  for mainnet use.
- **This is a single-shot, on-demand scan.** `execute.js` scans whatever's in `markets.config.json`
  once and exits. Real opportunities appear and disappear within a block or two, so catching them
  in practice means running this on a tight loop (or rewriting it as a persistent watcher) against
  a fast RPC — not invoking it by hand.
- **Contract ownership.** `executeArbitrage` and the withdraw functions are `onlyOwner`. Keep the
  owner key secure — anyone who compromises it can also call `withdrawToken`/`withdrawETH`. A
  multisig (e.g. Gnosis Safe) as owner is safer than a single EOA for anything beyond testing.

## Security notes

- `executeOperation` checks `msg.sender == address(POOL)` and `initiator == address(this)` so
  only Aave's Pool, in response to a loan this contract itself requested, can trigger the swap
  logic.
- `nonReentrant` guards the owner-facing entry points.
- Token approvals use `forceApprove` (OpenZeppelin) rather than a raw `approve`, so this remains
  compatible with tokens like USDT that don't allow changing a non-zero allowance directly.
- Get an independent audit before deploying with non-trivial capital. This has not been audited.
