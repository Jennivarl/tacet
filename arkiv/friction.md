# Friction report: building Tacet on Arkiv

Environment for every item below unless noted: `@arkiv-network/sdk` **0.8.1**, `viem` 2.x, Node **25.0.0** on Windows 11, Vite 8 in Chrome, **Tiramisu** testnet (chain `7738577`), 18 October 2026.

Only problems we actually hit, plus the paths that worked, each with steps to reproduce.

---

## 1. Attribute names with capital letters pass SDK validation, then revert on-chain

**Surface:** attribute names: TypeScript SDK `validateAttributeName` vs the Tiramisu `execute` contract

- **Expected:** a name the SDK accepts is a name the chain accepts. The SDK's own grammar is `/^[A-Za-z][A-Za-z0-9._-]*$/` (`src/attr/names.ts`), so we named an attribute `periodSec`.
- **Actual:** the transaction reverts at gas estimation with `Ident32InvalidByte(6, 0x53)`, which is the `S` in `periodSec`. The SDK then words the revert as *"an attribute name holds "S" (0x53) at byte 6, which is outside the name charset ("A"-"Z", "a"-"z", "0"-"9", ".", "-" and "_", with a letter first)"* (`src/utils/revert.ts`). So the message lists `A-Z` as allowed while rejecting an uppercase letter. It's self-contradictory and sent us looking for an invisible character first.
- **Reproduce:**
  ```ts
  await wallet.createEntity({
    attributes: { periodSec: u64(120) },
    payload: new Uint8Array(), contentType: "application/octet-stream",
    expires: ExpirationTime.fromMinutes(5),
  })
  // EntityMutationError: Transaction failed: an attribute name holds "S" (0x53) at byte 6 ...
  ```
  The same call with `period` succeeds.
- **Workaround:** lowercase attribute names only (`period` instead of `periodSec`).
- **Suggested fix:** make `NAME_RE` match the contract's `Ident32` charset (it appears to be lowercase-only), so the SDK rejects the name before signing, and derive the message's charset from the same constant. If uppercase is meant to be allowed, the contract is the side to fix.

## 2. Hitting the anonymous query budget makes the SDK hang silently for ~42 minutes

**Surface:** public Tiramisu RPC rate limit + `@arkiv-network/sdk` 0.8.1 query (viem `http()` transport defaults)

- **Expected:** when the anonymous budget runs out, a query rejects quickly with a clear "rate limited, resets in N minutes" error.
- **Actual:** the RPC answers `HTTP 429` with `retry-after: 2517` and `ratelimit: limit=10000, remaining=0, reset=2517`, body `{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}`. viem's default transport honours `Retry-After`, so `select(...).fetch()` neither resolves nor rejects. We measured a query still pending after 20 s, and our CLI and status scripts looked frozen. The body also isn't a JSON-RPC envelope, so nothing in the SDK can turn it into a typed error.
- **Reproduce:** exhaust the budget (our board ran 2 queries per canary every 20 s from two open tabs, plus a refresh on every `EntityCreated` on the chain), then:
  ```bash
  curl -si https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json'     -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["app = str('x')",{"select":{"key":true}}]}'
  ```
  and in TypeScript, `await client.select({ key: true }).where(eq("app", "x")).fetch()` stays pending.
- **What we changed:** `http(undefined, { retryCount: 0, timeout: 20_000 })` so we fail fast and show "public RPC paused for your network". We folded per-canary queries into **two queries per refresh**, polling went from 20 s to 60 s, and unknown `EntityCreated` events re-read at most once a minute. Scripts accept an access key via `ARKIV_API_KEY` (`X-API-KEY` header).
- **Suggested fix:** document the anonymous budget (units, window, what a query costs; the `Arkiv-Cost` header is exposed but undocumented), have the SDK create its transport with a capped Retry-After (or none) and throw a typed `RateLimitedError` carrying the reset time, and return a JSON-RPC-shaped error body.

## 2b. An unfunded account fails with "Execution error without revert data"

**Surface:** `createEntity` / `executeBatch` gas estimation

- **Expected:** "insufficient funds" when the signer has no GLM.
- **Actual:** `EntityMutationError: Transaction failed: Execution error without revert data`. We hit this in our seed script when the imposter wallet tried to write before its funding transfer was mined (our bug: we didn't wait for the receipt). A brand-new zero-balance key reproduces it every time.
- **Reproduce:** `createWalletClient` with `privateKeyToAccount(generatePrivateKey())`, then any `createEntity`.
- **Suggested fix:** check the balance in the SDK when estimation fails without revert data, and say "the signer has no GLM. Get some at hub.arkiv.network/faucet".

## 3. No event when an entity expires, which is the one moment this app cares about

**Surface:** `watchEntityEvents` (TypeScript SDK) / entity event ABI

- **Expected:** a canary's death is an Entity Expiration, so we expected to subscribe to it like any other lifecycle change (an `EntityExpired` event, or a handler such as `onEntityExpired`).
- **Actual:** the `EntityEvent` union in 0.8.1 has `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and `EntityDeleted` only (`src/types/events.ts`, `src/entity/events.ts`). Expiry is silent. A watcher that only listens to events never learns that a canary died.
- **Reproduce:**
  1. `createEntity({ ..., expires: ExpirationTime.fromSeconds(120) })`
  2. `client.watchEntityEvents({ onEvent: console.log })` over `webSocket()`
  3. Wait 3 minutes: `EntityCreated` arrives, nothing arrives at expiry.
- **Workaround we shipped:** poll every 60 s, and compute the countdown from `$expiration` (block) × `arkiv_getBlockTiming().duration` against the head block. The CLI and the web board both do this.
- **Suggested fix:** emit an `EntityExpired(entityKey, owner, expiredAt)` log from housekeeping, or add an SDK helper `watchExpirations({ keys })` that does the block-height comparison for you. Lease-style apps (canaries, presence, heartbeats, sessions) all need this.

## 4. `WalletArkivClient` can't predict entity keys, so the batch example needs two clients

**Surface:** `predictEntityKeys` + `executeBatch` (TypeScript SDK)

- **Expected:** the JSDoc example on `predictEntityKeys` calls `client.predictEntityKeys(...)` and then `client.executeBatch(...)` on the **same** `client`, so we expected the wallet client to have both.
- **Actual:** `createWalletClient` extends viem's `publicActions` and `walletArkivActions` only. `predictEntityKeys`, `select`, `getBlockTiming` and `watchEntityEvents` live in `arkivPublic` and are missing from the wallet client (`src/clients/createWalletClient.ts`, `src/clients/decorators/arkivWallet.ts`).
- **Reproduce:**
  ```ts
  const wallet = createWalletClient({ chain: tiramisu, transport: http(), account })
  await wallet.predictEntityKeys({ owner: account.address, count: 2 })
  // TS2339: Property 'predictEntityKeys' does not exist on type 'WalletArkivClient<...>'
  ```
- **Workaround:** create a separate `createPublicClient` for prediction and reads, and pass both into `publishCanary(reader, wallet, owner, input)` (`src/lib/canary.ts`).
- **Suggested fix:** also extend the wallet client with the Arkiv public actions (as viem's own wallet clients can `.extend(publicActions)`), or change the JSDoc example to use two clients.

## 5. Linking two entities in one atomic batch works well, once you find `predictEntityKeys`

**Surface:** `predictEntityKeys`, `salt`, `executeBatch`, `key()` attribute: **worked**

- **What we needed:** the canary's first pulse stores its promise's key, and both must land in the same transaction so that "pulse younger than promise" proves a break.
- **What worked:** `predictEntityKeys({ owner, count: 2 })` returns `{ key, salt }` pairs, and passing each `salt` into its create makes the engine mint exactly the predicted keys. We assert this after every publish (`predicted === createdEntities[0]`).
- **Friction:** this is only discoverable from the JSDoc in the package source. We didn't find it from the docs landing page. And if the same owner has another transaction in flight (for example a double-clicked "Publish" button), the prediction is silently wrong.
- **Suggested fix:** a docs page "Referencing an entity created in the same batch", and an option for `executeBatch` to fail fast when the predicted nonce no longer matches.

## 6. Faucet needs a browser wallet sign-in, so a fresh script key can't claim directly

**Surface:** Hub faucet (https://hub.arkiv.network/faucet)

- **Expected:** paste an address and receive test GLM. Our seed script uses a freshly generated key that has no browser wallet.
- **Actual:** the faucet only offers "Connect wallet". We had to claim into a browser wallet (MetaMask), add Tiramisu by hand, then send GLM to the script's address in a second transaction.
- **Reproduce:** open the faucet in a browser with no wallet extension. The only action is "Connect wallet".
- **Update:** after signing in there *is* a "Use a different address" link, so forwarding wasn't needed. But see the next item.
- **Suggested fix:** show the "send to" field before sign-in, so script and CI keys are obviously supported.

## 6b. Faucet drained on deadline day: every claim fails with a raw viem error

**Surface:** Hub faucet, 18 Oct 2026 ~19:29 BST (about 4.5 h before submissions closed)

- **Expected:** claim 10 test GLM.
- **Actual:** red box with the full viem error dump: `insufficient funds for gas * price + value: have 9995400999990802000 want 10000000000000000000 (viem@2.51.3)`. The faucet wallet `0x815Ad950ae49102952C10ceBB18901E9e28AC712` held 9.9954 GLM and tried to send exactly 10, so it can never succeed until it is refilled. The one-hour per-wallet cooldown still applies after the failed claim.
- **Reproduce:** check the faucet wallet balance with `eth_getBalance`. Whenever it is below `10 GLM + gas`, every claim fails the same way.
- **Impact:** we were blocked from writing our first entity for about an hour, until a community member sent GLM by hand (it arrived around 20:30 BST). The faucet wallet still held the same 9.9954 GLM then. On Tiramisu gas is 1 gwei, so our whole project needs well under 0.1 GLM. A 10 GLM drip is far more than builders need.
- **Suggested fix:** send `min(10, balance − reserve)`, alert the team at a low-balance threshold, show "Faucet is empty, try later / ask in Discord" instead of the raw error, and consider a smaller drip (1 GLM) so the faucet lasts longer.

## 7. Durations must be a multiple of the 2 s block time: clear error, no friction

**Surface:** `ExpirationTime.fromSeconds`: **worked**

- `ExpirationTime.fromSeconds(121)` throws `InvalidExpiryError` with the suggestion "Try 120 or 122, or ExpirationTime.fromBlocks(n)". That's a great message. All our periods (120 s, 1 h, 1 d, 7 d, 30 d) are even, so nothing else was needed.

## 8. Lifetime Extension semantics ("sets", not "adds") fit renewals exactly

**Surface:** `extendEntity`: **worked**

- `extendEntity({ entityKey, expires: ExpirationTime.fromSeconds(period) })` sets the expiry to *now + period*. That's exactly what a canary renewal means, so there's no arithmetic on the client. Renewing immediately after creation still succeeds, because the new expiry is a few blocks later than the old one.

## 9. `createdBy()` makes the security model a one-liner

**Surface:** query builder `createdBy()` / `$creator`: **worked**

- Pinning `.createdBy(promise.creator)` on the pulse query is the whole anti-spoofing defence. We verified it with a second "imposter" wallet that wrote a 30-day pulse pointing at a dead canary's promise. The trusted query ignores it, and an unpinned query returns it (shown in the UI as "fake renewal ignored").

