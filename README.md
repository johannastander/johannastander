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
scripts/execute.js                 off-chain: quotes both directions, fires the trade if profitable
test/FlashLoanArbitrage.test.js    smoke tests (owner checks, access control)
.env.example                       config template
```

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC_URL, PRIVATE_KEY, AAVE_ADDRESSES_PROVIDER, routers, tokens
npx hardhat compile
```

**Start on a testnet.** Use Sepolia (or another network with an Aave V3 deployment and DEX
liquidity) before touching mainnet funds. Aave's deployed addresses per network are listed at
https://aave.com/docs/resources/addresses.

Deploy:

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

Copy the deployed address into `ARBITRAGE_CONTRACT` in `.env`, then set `ROUTER_A`, `ROUTER_B`,
`TOKEN_BORROW`, `TOKEN_INTERMEDIATE`, and `BORROW_AMOUNT` (in the borrow token's smallest unit).

Run the bot once:

```bash
npx hardhat run scripts/execute.js --network sepolia
```

`scripts/execute.js` quotes both directions off-chain, and if either is profitable it prints the
opportunity — direction, amounts, expected profit — and **asks for confirmation before submitting
anything on-chain**. Nothing gets sent until you type `y`. For unattended/cron use, set
`AUTO_CONFIRM=true` in `.env` to skip the prompt and submit automatically once a trade clears your
`SLIPPAGE_BPS` and profit floor.

For it to actually catch real opportunities you'd run it on a loop against a fast RPC — the
version here is a single-shot check, not a production keeper loop.

## Things you need to fix before this touches real money

This code is a working starting point, not a profitable bot out of the box. In particular:

- **Slippage protection is disabled.** `amountOutMinBuy`/`amountOutMinSell` are hardcoded to `0`
  in `scripts/execute.js`. That means an adversary can sandwich your swaps. Compute real minimums
  (e.g. quoted amount minus a basis-point tolerance) before running this with meaningful size.
- **MEV / front-running.** Public mempool transactions that reveal a profitable arbitrage can be
  copied or front-run by other bots/searchers. Consider a private relay (e.g. Flashbots Protect)
  for mainnet use.
- **Gas costs and Aave's flash loan premium** (0.05% on Aave V3 as of writing) both eat into
  profit — `minProfit` only guards the on-chain swap math, not gas.
- **This only checks two pools for one hardcoded pair.** Real opportunities move across many
  pairs/pools; you'd extend `execute.js` (or rewrite it as a persistent service) to scan more
  markets and react faster than a single-shot script can.
- **Contract ownership.** `executeArbitrage` and the withdraw functions are `onlyOwner`. Keep the
  owner key secure — anyone who compromises it can also call `withdrawToken`/`withdrawETH`.

## Security notes

- `executeOperation` checks `msg.sender == address(POOL)` and `initiator == address(this)` so
  only Aave's Pool, in response to a loan this contract itself requested, can trigger the swap
  logic.
- `nonReentrant` guards the owner-facing entry points.
- Token approvals use `forceApprove` (OpenZeppelin) rather than a raw `approve`, so this remains
  compatible with tokens like USDT that don't allow changing a non-zero allowance directly.
- Get an independent audit before deploying with non-trivial capital. This has not been audited.
