// Shared Tacet data contract: used by the web app, the seed script and the CLI watcher.
// See /arkiv/schema.md for the human-readable version.
import {
  createPublicClient,
  ExpirationTime,
  jsonToPayload,
  type PublicArkivClient,
  type WalletArkivClient,
} from "@arkiv-network/sdk"
import { key, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { type Hex, http, type Transport, webSocket } from "viem"

/** Every Tacet entity carries this, so we never read other apps' data. */
export const APP = "tacet-v1"

/** A promise lives long enough to outlast judging; it is the public record of "we renew every N". */
export const PROMISE_LIFETIME = ExpirationTime.fromDays(90)

export const PERIODS: { label: string; seconds: number }[] = [
  { label: "2 minutes (demo)", seconds: 120 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
]

export const EXPLORER = "https://tiramisu.explorer.arkiv.network"

// Anonymous RPC use has an hourly query budget. When it runs out the node answers 429 with a
// Retry-After of up to an hour, which viem would otherwise wait out silently. Fail fast instead.
// Scripts can pass an Arkiv access key (hub.arkiv.network) through ARKIV_API_KEY. The local dev
// server can use VITE_ARKIV_API_KEY from .env.development.local, which `vite build` never reads,
// so a key never ships in the public site.
const apiKey =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ARKIV_API_KEY ??
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ARKIV_API_KEY

export function makePublicClient(
  transport: Transport = http(undefined, {
    retryCount: 0,
    timeout: 20_000,
    ...(apiKey ? { fetchOptions: { headers: { "X-API-KEY": apiKey } } } : {}),
  }),
): PublicArkivClient {
  return createPublicClient({ chain: tiramisu, transport }) as PublicArkivClient
}

/** True when the node refused a request because the anonymous query budget is used up. */
export function isRateLimited(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${(e as { status?: number }).status ?? ""}` : String(e)
  return /429|ANON_COST_LIMITED|Too Many Requests/i.test(text)
}

export function makeSocketClient(): PublicArkivClient {
  return createPublicClient({ chain: tiramisu, transport: webSocket() }) as PublicArkivClient
}

export type Status = "alive" | "due" | "dead"

export type Canary = {
  promiseKey: Hex
  creator: Hex
  org: string
  slug: string
  category: string
  statement: string
  website: string
  periodSec: number
  promiseCreatedAt: bigint
  promiseExpiresAt: bigint
  /** The trusted pulse: same promise key AND created by the promise's creator. */
  pulse?: { key: Hex; createdAt: bigint; expiresAt: bigint }
  /** Pulses that point at this promise but were written by a different wallet. Ignored. */
  spoofedPulses: number
  status: Status
  secondsLeft: number
  /** The pulse was created after the promise, so the original pulse died at least once. */
  restarted: boolean
  /** Another wallet published a promise under the same name. */
  nameClaimedBy: Hex[]
  /** A different wallet claimed this name first, so this one is the likely imposter. */
  laterClaim: boolean
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
}

const attrValue = (e: { attributes?: Record<string, { value: unknown }> }, name: string) =>
  e.attributes?.[name]?.value

/** Head block and seconds per block, used to turn `$expiration` (a block) into a countdown. */
export async function headInfo(client: PublicArkivClient) {
  const t = await client.getBlockTiming()
  return { block: t.currentBlock, blockSeconds: t.blockDuration || 2 }
}

/**
 * Reads every canary. `atBlock` replays the board as it was at a past block, which is how anyone
 * can prove a canary was alive (or already dead) at a given moment, even after it has expired.
 */
export async function loadCanaries(
  client: PublicArkivClient,
  opts: { atBlock?: bigint } = {},
): Promise<{ canaries: Canary[]; block: bigint; blockSeconds: number }> {
  const head = await headInfo(client)
  const block = opts.atBlock ?? head.block

  // Two queries per refresh, whatever the number of canaries: every promise, and every pulse.
  const promiseQuery = client
    .select({ key: true, creator: true, createdAt: true, expiresAt: true, payload: true, attributes: true })
    .where(eq("app", APP), eq("kind", "promise"))
    .limit(200)
  const pulseQuery = client
    .select({ key: true, creator: true, createdAt: true, expiresAt: true, attributes: { promise: true } })
    .where(eq("app", APP), eq("kind", "pulse"))
    .limit(200)
  if (opts.atBlock !== undefined) {
    promiseQuery.atBlock(opts.atBlock)
    pulseQuery.atBlock(opts.atBlock)
  }
  const promises: Awaited<ReturnType<typeof promiseQuery.fetch>>["entities"][number][] = []
  const pulsesByPromise = new Map<string, { key: Hex; creator: Hex; createdAt: bigint; expiresAt: bigint }[]>()
  await Promise.all([
    (async () => {
      for await (const p of promiseQuery) promises.push(p)
    })(),
    (async () => {
      for await (const q of pulseQuery) {
        const target = String(attrValue(q, "promise") ?? "").toLowerCase()
        pulsesByPromise.set(target, [...(pulsesByPromise.get(target) ?? []), q])
      }
    })(),
  ])

  const canaries = promises.map((p): Canary => {
    const promiseKey = p.key as Hex
    const creator = p.creator as Hex
    const claiming = pulsesByPromise.get(promiseKey.toLowerCase()) ?? []

    // The `promise` attribute is writable by anyone, so it is never trusted alone: a pulse only
    // counts if its immutable $creator is the promise's creator. The detail page shows the same
    // rule as a single createdBy() query anyone can run.
    const isCreator = (q: { creator: Hex }) => q.creator.toLowerCase() === creator.toLowerCase()
    const live = claiming
      .filter((q) => isCreator(q) && q.expiresAt > block)
      .sort((a, b) => Number(b.expiresAt - a.expiresAt))
    const best = live[0]
    const spoofedPulses = claiming.filter((q) => !isCreator(q)).length

    let payload: { statement?: string; website?: string } = {}
    try {
      payload = p.toJson()
    } catch {}

    const periodSec = Number(attrValue(p, "period") ?? 0)
    const secondsLeft = best ? Number(best.expiresAt - block) * head.blockSeconds : 0
    const status: Status = !best ? "dead" : secondsLeft < periodSec * 0.2 ? "due" : "alive"

    return {
      promiseKey,
      creator,
      org: String(attrValue(p, "org") ?? "?"),
      slug: String(attrValue(p, "slug") ?? ""),
      category: String(attrValue(p, "category") ?? "other"),
      statement: payload.statement ?? "",
      website: payload.website ?? "",
      periodSec,
      promiseCreatedAt: p.createdAt,
      promiseExpiresAt: p.expiresAt,
      pulse: best ? { key: best.key, createdAt: best.createdAt, expiresAt: best.expiresAt } : undefined,
      spoofedPulses,
      status,
      secondsLeft,
      restarted: best ? best.createdAt !== p.createdAt : false,
      nameClaimedBy: [],
      laterClaim: false,
    }
  })

  // Same name, different wallets: the name is just a label, the wallet is the identity.
  const bySlug = new Map<string, Canary[]>()
  for (const c of canaries) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c])
  for (const c of canaries) {
    const same = bySlug.get(c.slug) ?? []
    c.nameClaimedBy = [...new Set(same.map((x) => x.creator.toLowerCase()))].filter(
      (a) => a !== c.creator.toLowerCase(),
    ) as Hex[]
    const first = same.reduce((a, b) => (b.promiseCreatedAt < a.promiseCreatedAt ? b : a), c)
    c.laterClaim = c.nameClaimedBy.length > 0 && first.creator.toLowerCase() !== c.creator.toLowerCase()
  }

  canaries.sort((a, b) => order(a.status) - order(b.status) || a.org.localeCompare(b.org))
  return { canaries, block, blockSeconds: head.blockSeconds }
}

const order = (s: Status) => (s === "dead" ? 0 : s === "due" ? 1 : 2)

export type PublishInput = {
  org: string
  category: string
  statement: string
  website: string
  periodSec: number
}

function promiseParams(input: PublishInput, salt: bigint) {
  return {
    attributes: {
      app: APP,
      kind: "promise",
      org: input.org.slice(0, 64),
      slug: slugify(input.org),
      category: input.category,
      period: u64(input.periodSec),
    },
    payload: jsonToPayload({ statement: input.statement, website: input.website }),
    contentType: "application/json",
    expires: PROMISE_LIFETIME,
    // The promise can never be rewritten after the fact.
    flags: { readonly: true },
    salt,
  }
}

export function pulseParams(promiseKey: Hex, input: PublishInput, salt?: bigint) {
  return {
    attributes: {
      app: APP,
      kind: "pulse",
      promise: key(promiseKey),
      slug: slugify(input.org),
      period: u64(input.periodSec),
    },
    payload: new Uint8Array(),
    contentType: "application/octet-stream",
    expires: ExpirationTime.fromSeconds(input.periodSec),
    // readonly: nothing to edit. permissionlessExtension stays OFF on purpose: if anyone could
    // extend a pulse, an attacker (or whoever gagged the company) could keep the canary alive.
    flags: { readonly: true, permissionlessExtension: false },
    ...(salt === undefined ? {} : { salt }),
  }
}

/**
 * Publishes a canary: the long-lived promise and its first short-lived pulse in ONE atomic batch.
 * The pulse must reference the promise's key, so both keys are predicted before sending.
 * Because they share a creation block, a pulse whose $createdAt differs from its promise's is
 * proof the canary went dark at least once.
 */
export async function publishCanary(
  reader: PublicArkivClient,
  wallet: WalletArkivClient,
  owner: Hex,
  input: PublishInput,
) {
  const [p, q] = await reader.predictEntityKeys({ owner, count: 2 })
  const res = await wallet.executeBatch({
    creates: [promiseParams(input, p.salt), pulseParams(p.key, input, q.salt)],
  })
  const [promiseKey, pulseKey] = res.createdEntities
  if (promiseKey?.toLowerCase() !== p.key.toLowerCase()) {
    throw new Error(`Predicted promise key ${p.key} but the engine minted ${promiseKey}`)
  }
  return { promiseKey: promiseKey as Hex, pulseKey: pulseKey as Hex, txHash: res.txHash }
}

export function renewParams(pulseKey: Hex, periodSec: number) {
  return { entityKey: pulseKey, expires: ExpirationTime.fromSeconds(periodSec) }
}

export function fmtDuration(sec: number): string {
  if (sec <= 0) return "0s"
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/** A renewal period in words: "2 min", "1 hour", "7 days". */
export function fmtPeriod(sec: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
  if (sec % 86400 === 0) return unit(sec / 86400, "day")
  if (sec % 3600 === 0) return unit(sec / 3600, "hour")
  if (sec % 60 === 0) return `${sec / 60} min`
  return `${sec}s`
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
