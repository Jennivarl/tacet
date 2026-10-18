# Tacet: Arkiv schema

Network: **Tiramisu testnet** (chain ID `7738577`) · SDK: `@arkiv-network/sdk` **0.8.1** · Code: [`src/lib/canary.ts`](../src/lib/canary.ts)

Tacet stores warrant canaries as two Arkiv entity types. Every entity carries `app = "tacet-v1"` so we never read another app's data from the shared database.

## The questions the app must answer

1. **Is this company's canary still alive?** That means a pulse exists that points at the promise, was created by the promise's creator, and has not expired.
2. **Has this canary ever gone quiet?** That means the live pulse was created in a later block than the promise.
3. **Is someone faking it?** That means a pulse pointing at the promise from a different creator, or a promise with the same name from a different wallet.
4. **What did the board look like at block N?** That's the same queries with `atBlock`.

## Entity type 1: `promise`

The public, long-lived commitment: "We are Fennec VPN, and we renew our canary every 7 days."

| Field | Type | Example | Why |
|---|---|---|---|
| `app` | `str` | `tacet-v1` | namespace filter |
| `kind` | `str` | `promise` | entity type filter |
| `org` | `str` | `Fennec VPN` | display label only, **never trusted** |
| `slug` | `str` | `fennec-vpn` | groups same-name claims to detect imposters |
| `category` | `str` | `vpn` | display / filtering |
| `period` | `u64` | `604800` | renewal period in seconds. Numeric, so range queries work |
| payload | JSON | `{ "statement": "...", "website": "https://..." }` | the human statement. Not queryable, never filtered on |
| content type | | `application/json` | |

- **Entity Expiration:** 90 days (`ExpirationTime.fromDays(90)`). Long enough to outlive judging and to keep the record of "this company promised to renew" visible after its pulse dies.
- **Creation flags:** `readonly: true`. The promise can never be rewritten after the fact.

## Entity type 2: `pulse`

The canary itself. It is alive only while the company keeps renewing it.

| Field | Type | Example | Why |
|---|---|---|---|
| `app` | `str` | `tacet-v1` | namespace filter |
| `kind` | `str` | `pulse` | entity type filter |
| `promise` | `key` | `0x5f…` (promise entity key) | links the pulse to its promise |
| `slug` | `str` | `fennec-vpn` | convenience for CLI / explorer reading |
| `period` | `u64` | `604800` | renewal period in seconds, so a renewal knows how far to extend |
| payload | empty | | the pulse's existence *is* the message |

- **Entity Expiration:** exactly one renewal period (`ExpirationTime.fromSeconds(period)`).
- **Lifetime Extension:** "Renew" calls `extendEntity({ entityKey, expires: ExpirationTime.fromSeconds(period) })`, which sets the expiry to *now + period*.
- **Creation flags:** `readonly: true` (nothing to edit) and **`permissionlessExtension: false`, on purpose.** If anyone could extend a pulse, an attacker, or the very authority that gagged the company, could keep a dead canary looking alive.

## How the two are written: one atomic batch

`publishCanary()` predicts both keys with `predictEntityKeys({ owner, count: 2 })`, then sends **one** `executeBatch` with the promise and its first pulse. The pulse's `promise` attribute holds the promise's predicted key, and each create carries the matching `salt`.

Because both land in the same block, `pulse.$createdAt == promise.$createdAt` for an unbroken canary. If the original pulse ever expires and the company creates a new one, the new pulse's `$createdAt` is later. **That break is visible forever** (until the promise itself expires), and the company cannot hide it.

## Queries the app runs

All reads go straight to the public Tiramisu RPC. Tacet has no backend.

The board runs **two queries per refresh**, however many canaries exist. Anonymous RPC use has an hourly query budget (see friction.md), so the per-canary queries we started with were folded into these two.

**1. Every promise** (board):
```
app = str('tacet-v1') AND kind = str('promise')
```
Selects key, creator, createdAt, expiresAt, payload and attributes. `limit(200)`, walked with the cursor (`for await`).

**2. Every pulse** (board):
```
app = str('tacet-v1') AND kind = str('pulse')
```
Selects key, creator, createdAt, expiresAt and only the `promise` attribute. Pulses are grouped by their `promise` key on the client:
- **trusted** if the pulse's `$creator` equals the promise's `$creator`,
- **fake renewal ignored** if it points at the promise but was written by any other wallet.

**The trust rule as one query** (shown on every canary's page, so anyone can verify without this site):
```ts
client.select({ key: true, creator: true, expiresAt: true })
  .where(eq("app", APP), eq("kind", "pulse"), eq("promise", key(promiseKey)))
  .createdBy(promise.creator)          // pins the IMMUTABLE $creator
```
Sent to the node as:
```
app = str('tacet-v1') AND kind = str('pulse') AND promise = key(0x<promiseKey>) AND $creator = addr(0x<creator>)
```
The `promise` attribute is writable by anyone who creates an entity, so it is never trusted alone. Only the immutable `$creator` decides. Without it, anyone could create a pulse pointing at a dead company's promise.

**Time machine:** both board queries with `.atBlock(n)`. Anyone can prove what the board said at block *n*, including canaries that have since expired. That's the "evidence that survives expiry".

**Live updates:** `watchEntityEvents` over a **WebSocket** transport, without `fromBlock`. Events for known keys (renewals, deletions) trigger a re-read straight away. Creations from unknown keys re-read at most once a minute, because the socket carries every app's events. Expiry emits no event (see friction.md), so the board also re-reads every 60 s and computes the countdown from `$expiration` and `arkiv_getBlockTiming`.

## Status rules (client side)

| Status | Rule |
|---|---|
| 🟢 Alive | trusted pulse exists and `expiresAt − head ≥ 20 % of period` |
| 🟡 Due soon | trusted pulse exists and less than 20 % of the period is left |
| 🔴 Gone quiet | no trusted pulse (expired or deleted) |
| ↺ Restarted | trusted pulse `$createdAt` ≠ promise `$createdAt` |
| ⚠ Possible imposter | another wallet published a promise with the same `slug` earlier |
| 🛡 Fake renewal ignored | pulses pointing at this promise from another creator |

There's no server-side ordering, so sorting (gone quiet first, then due, then alive) happens on the client.

## What we deliberately keep off Arkiv

- **Private keys.** They stay in the company's wallet (`.env` for the seed script, never committed).
- **Anything about the people who rely on a canary.** Watching is anonymous, needs no account, and nothing is written.
- **The legal documents.** The canary is only the signal. The statement text is short and public by design.
- **All demo data is synthetic.** The organizations are fictional and there is no personal data.

## Wallets that create entities (Tiramisu)

| Address | Role |
|---|---|
| `0x91128B8EeCF4f9c58fa67F9b9750983106eA6986` | "company" wallet: publishes and renews the demo canaries (Fennec VPN, Owlpost Mail, Harbor Cloud, Kite Chat) |
| `0x584692C246d873b651D61A6D782095d37A48C45a` | "imposter" wallet: publishes the fake "Fennec VPN" promise and the spoofed Harbor Cloud pulse, to demo the `$creator` defence |
