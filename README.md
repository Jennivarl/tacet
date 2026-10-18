# 🐤 Tacet

**Warrant canaries that die on their own.** Built on [Arkiv](https://arkiv.network), the Web3 database.

**Live app:** https://tacet-zeta.vercel.app · Tracks: **Censorship Resistance**, **Security**

## The problem

A *warrant canary* is a line a company publishes: *"We have not received a secret government order for your data."* It renews the line regularly. If it gets a gag order it isn't allowed to say so, but it can stop renewing. The silence is the warning.

Today canaries live on the company's own website, so:

- a hacker can fake a renewal,
- the date can be quietly backdated,
- the page can be taken down,
- nobody is alerted when a canary goes quiet (Reddit's canary vanished in 2016 and people noticed by chance).

**Who is harmed:** journalists, their sources, activists, and anyone who picks a VPN, email or cloud provider because it promises to warn them. If the canary is censored, kept alive by someone else, or silently goes stale, they keep trusting a compromised provider.

## What Tacet does

- A company publishes its canary on Arkiv from its own wallet and renews it with a **Lifetime Extension**.
- If it stops, **Entity Expiration** removes the canary by itself. No server, cron job or person has to act.
- The board shows 🟢 alive / 🟡 due soon / 🔴 gone quiet, and flags fakes:
  - a "renewal" written by any other wallet is **ignored** (we filter on the immutable `$creator`),
  - a second wallet using the same company name is flagged as a **possible imposter**,
  - a canary that went quiet and was restarted is flagged **forever** (its pulse is younger than its promise).
- A **time machine** (`atBlock` queries) shows what the board said at any past block, as proof that survives expiry.
- Anyone can verify a canary **without this website**: every card shows the exact query and a `curl` command against the public RPC, and there's a CLI watcher.

Full data design: [`arkiv/schema.md`](arkiv/schema.md) · Building notes: [`arkiv/friction.md`](arkiv/friction.md)

## Why Arkiv

| Instead of Arkiv | What breaks |
|---|---|
| Postgres / our own API | Whoever runs the server controls the clock and the rows. They can edit, backdate, delete, or be ordered to keep a dead canary "alive". |
| IPFS | Content is permanent and has no expiry, so a canary can't die on its own. There are no queries by company, creator or expiry. |
| A subgraph | Needs a contract, a keeper/cron to expire things, and someone running the indexer. All of those are a party that can be pressured. |

Arkiv gives the three properties this product depends on, in one place: **network-enforced expiry**, an **immutable creator**, and **public queries** that any RPC answers.

**Kept off Arkiv on purpose:** private keys, anything about the people watching (watching is anonymous and writes nothing), and the legal documents themselves.

## Run it locally

```bash
git clone https://github.com/Jennivarl/tacet && cd tacet
npm install
npm run dev            # web app on http://localhost:5173 (read-only works with no wallet)
npm run watch          # CLI watcher for every canary (talks straight to the Tiramisu RPC)
npm run watch -- 0x<promiseKey>   # watch one canary
```

To publish from the browser, connect MetaMask or Rabby. The app adds the Tiramisu network (chain `7738577`) for you. Get test GLM from the [faucet](https://hub.arkiv.network/faucet).

### Re-create the demo data

```bash
cp .env.example .env    # put a funded Tiramisu test key in PRIVATE_KEY
npm run seed            # ~3 minutes: creates 4 canaries, renews one, lets two expire,
                        # restarts one, and runs the imposter + spoofed-renewal attacks
```

## How judges can reproduce the Arkiv usage

1. Open the live app. The board reads canaries straight from Tiramisu. Harbor Cloud is 🔴 gone quiet (a 2-minute canary that was never renewed).
2. Open **Harbor Cloud → Verify it yourself**. Copy the `curl` command and run it: the result is empty, so the canary is dead. The card also shows "🛡 1 fake renewal ignored": the imposter wallet wrote a 30-day pulse pointing at Harbor's promise, and it's ignored because its `$creator` is wrong.
3. Look at **Fennec VPN**. There are two cards with that name, and the later one is flagged "⚠ Possible imposter".
4. Look at **Kite Chat**: it shows "↺ Restarted" because its live pulse was created after its promise.
5. Use the **time machine** with a block from before Harbor expired (see its "Promise created at block" on the detail page) to see it alive again.
6. **Publish** your own 2-minute canary from the Publish page, renew it once, then stop and watch it turn red. `npm run watch` in a terminal beeps when it dies.

## Wallets that create entities (Tiramisu)

| Address | Role |
|---|---|
| `0x91128B8EeCF4f9c58fa67F9b9750983106eA6986` | Company wallet: publishes and renews the demo canaries |
| `0x584692C246d873b651D61A6D782095d37A48C45a` | Imposter wallet: fake "Fennec VPN" promise and spoofed Harbor Cloud pulse |

## Stack

Vite + TypeScript (no framework, no backend), `@arkiv-network/sdk` 0.8.1, viem. Built 18 October 2026 for Arkiv: Global Tour Stop. All demo organizations are fictional.

## License

MIT
