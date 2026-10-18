import "./style.css"
import { createWalletClient, type WalletArkivClient } from "@arkiv-network/sdk"
import { key } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { custom, type Hex } from "viem"
import {
  APP,
  type Canary,
  EXPLORER,
  fmtDuration,
  fmtPeriod,
  isRateLimited,
  loadCanaries,
  makePublicClient,
  makeSocketClient,
  PERIODS,
  publishCanary,
  pulseParams,
  renewParams,
  short,
} from "./lib/canary"

const RPC = tiramisu.rpcUrls.default.http[0]
const REPO = "https://github.com/Jennivarl/tacet"
const reader = makePublicClient()
const app = document.querySelector<HTMLElement>("#app")!

const state = {
  canaries: [] as Canary[],
  block: 0n,
  blockSeconds: 2,
  atBlock: undefined as bigint | undefined,
  loadedAt: 0,
  loading: true,
  error: "",
  live: false,
}
let account: Hex | undefined
let wallet: WalletArkivClient | undefined

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const route = () => location.hash.replace(/^#\/?/, "")
const ext = (href: string, label: string, cls = "") =>
  `<a class="${cls}" href="${href}" target="_blank" rel="noopener">${label}</a>`
const addrLink = (a: string) => ext(`${EXPLORER}/address/${a}`, short(a), "mono link")
const txLink = (h: string) => ext(`${EXPLORER}/tx/${h}`, short(h), "mono link")
const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e))

const PATHS: Record<string, string> = {
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 5 9 7a8.7 8.7 0 0 1-2.4 3.4M6.3 6.3C4.2 7.7 3 10 3 12c0 2 4 7 9 7 1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
}
const icon = (name: string, cls = "") =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`

function hue(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

const STATUS = {
  alive: { label: "Alive" },
  due: { label: "Due soon" },
  dead: { label: "Gone quiet" },
}

// ---------- data ----------

async function refresh() {
  try {
    const r = await loadCanaries(reader, { atBlock: state.atBlock })
    Object.assign(state, r, { loadedAt: Date.now(), loading: false, error: "" })
  } catch (e) {
    state.loading = false
    state.loadedAt = Date.now()
    state.error = isRateLimited(e)
      ? "Arkiv's public RPC has paused anonymous reads from your network for now (hourly query budget). It resets within the hour. Showing the last data we read."
      : errText(e)
  }
  render(false)
}

let pending: ReturnType<typeof setTimeout> | undefined
function scheduleRefresh(delay = 1500) {
  if (state.atBlock !== undefined) return
  clearTimeout(pending)
  pending = setTimeout(refresh, delay)
}

// Renewals and new canaries arrive over a real WebSocket. Expiry emits no event, so we also poll.
// The socket carries every app's events, so unknown creations re-read at most once a minute.
let lastCreatedRefresh = 0
function startLive() {
  try {
    makeSocketClient().watchEntityEvents({
      onEvent: (e) => {
        const known = state.canaries.some((c) => c.promiseKey === e.entityKey || c.pulse?.key === e.entityKey)
        if (known) scheduleRefresh()
        else if (e.type === "EntityCreated" && Date.now() - lastCreatedRefresh > 60_000) {
          lastCreatedRefresh = Date.now()
          scheduleRefresh(3000)
        }
      },
      onError: () => (state.live = false),
    })
    state.live = true
  } catch {
    state.live = false
  }
  setInterval(() => scheduleRefresh(0), 60_000)
}

// Countdowns and life bars tick locally between refreshes.
setInterval(() => {
  if (state.atBlock !== undefined) return
  const elapsed = (Date.now() - state.loadedAt) / 1000
  let expired = false
  for (const el of document.querySelectorAll<HTMLElement>("[data-left]")) {
    const left = Number(el.dataset.left) - elapsed
    el.textContent = left > 0 ? fmtDuration(left) : "now"
    if (left <= 0) expired = true
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-bar]")) {
    const left = Number(el.dataset.bar) - elapsed
    el.style.width = `${Math.max(0, Math.min(100, (left / Number(el.dataset.period)) * 100))}%`
  }
  if (expired && Date.now() - state.loadedAt > 15_000) scheduleRefresh(3000)
}, 1000)

// ---------- components ----------

function chip(c: Canary) {
  return `<span class="chip chip-${c.status}"><i class="dot"></i>${STATUS[c.status].label}</span>`
}

function avatar(c: Canary, size = "") {
  return `<div class="avatar ${size}" style="--h:${hue(c.slug)}" aria-hidden="true">${esc(c.org.trim()[0] ?? "?")}</div>`
}

function flags(c: Canary) {
  const out: string[] = []
  if (c.laterClaim)
    out.push(`<li class="flag flag-warn">${icon("alert")}<span><b>Possible imposter.</b> Another wallet claimed "${esc(c.org)}" first.</span></li>`)
  else if (c.nameClaimedBy.length)
    out.push(`<li class="flag flag-warn">${icon("alert")}<span><b>Name shared</b> with ${c.nameClaimedBy.length} other wallet${c.nameClaimedBy.length > 1 ? "s" : ""}. Trust the wallet, not the name.</span></li>`)
  if (c.spoofedPulses)
    out.push(`<li class="flag flag-ok">${icon("shield")}<span><b>${c.spoofedPulses} fake renewal${c.spoofedPulses > 1 ? "s" : ""} ignored.</b> Written by the wrong wallet.</span></li>`)
  if (c.restarted)
    out.push(`<li class="flag flag-warn">${icon("restart")}<span><b>Restarted.</b> This canary went quiet before.</span></li>`)
  return out.length ? `<ul class="flags">${out.join("")}</ul>` : ""
}

function life(c: Canary, big = false) {
  if (c.status === "dead")
    return `<div class="life life-dead ${big ? "life-big" : ""}">
      <svg class="flatline" viewBox="0 0 ${big ? 600 : 200} 24" preserveAspectRatio="none" aria-hidden="true"><path d="${big ? "M0 12h290l4-8 4 16 4-8h298" : "M0 12h70l6-8 6 16 6-8h112"}"/></svg>
      <div class="life-row"><span>No renewal. The canary expired.</span></div>
    </div>`
  const pct = Math.max(0, Math.min(100, (c.secondsLeft / c.periodSec) * 100))
  return `<div class="life ${big ? "life-big" : ""}">
    <div class="life-row"><span>${icon("clock")} Next renewal due in</span><b class="mono" data-left="${c.secondsLeft}">${fmtDuration(c.secondsLeft)}</b></div>
    <div class="bar"><span class="bar-fill bar-${c.status}" style="width:${pct}%" data-bar="${c.secondsLeft}" data-period="${c.periodSec}"></span></div>
  </div>`
}

function card(c: Canary) {
  return `
  <article class="card card-${c.status}">
    <header class="card-head">
      ${avatar(c)}
      <div class="card-title">
        <h3><a href="#/c/${c.promiseKey}">${esc(c.org)}</a></h3>
        <span class="sub">${esc(c.category)} · every ${fmtPeriod(c.periodSec)}</span>
      </div>
      ${chip(c)}
    </header>
    <p class="statement">${esc(c.statement)}</p>
    ${life(c)}
    ${flags(c)}
    <footer class="card-foot">
      <span class="muted">Signed by ${addrLink(c.creator)}</span>
      <a class="link-arrow" href="#/c/${c.promiseKey}">Verify ${icon("arrow")}</a>
    </footer>
  </article>`
}

function codeBlock(label: string, code: string) {
  return `<div class="code">
    <div class="code-head"><span>${label}</span><button class="copy" type="button" data-copy="${esc(code)}">${icon("copy")}<span>Copy</span></button></div>
    <pre><code>${esc(code)}</code></pre>
  </div>`
}

const heroVisual = `
  <div class="hero-visual" aria-hidden="true">
    <div class="hv-card">
      <div class="hv-head">
        <span class="hv-name"><span class="avatar avatar-sm" style="--h:28">F</span> Fennec VPN</span>
        <span class="chip chip-alive"><i class="dot"></i>Alive</span>
      </div>
      <svg class="ecg" viewBox="0 0 560 120" preserveAspectRatio="none">
        <path class="ecg-alive" pathLength="100" d="M0 64h30l7-9 7 9h16l8-46 11 84 8-38h40l7-9 7 9h16l8-46 11 84 8-38h40l7-9 7 9h16l8-46 11 84 8-38h24"/>
        <path class="ecg-dead" d="M305 64H552"/>
        <circle class="ecg-dot-ring" cx="552" cy="64" r="11"/><circle class="ecg-dot" cx="552" cy="64" r="5"/>
      </svg>
      <div class="hv-legend">
        <span><i class="sw sw-alive"></i>Renewed on time</span>
        <span><i class="sw sw-dead"></i>Silence is the signal</span>
      </div>
    </div>
    <div class="hv-float hv-float-a">${icon("shield")}<span>Only the company's wallet can renew</span></div>
    <div class="hv-float hv-float-b">${icon("zap")}<span>Expires by itself. No server needed</span></div>
  </div>`

// ---------- views ----------

// The board's live parts are re-rendered on every refresh. The hero and controls stay put, so
// animations don't replay and a half-typed block number is not wiped.
function boardStats() {
  const history = state.atBlock !== undefined
  const counts = { alive: 0, due: 0, dead: 0 }
  for (const c of state.canaries) counts[c.status]++
  return `
  <section class="stats" aria-label="Summary">
    <div class="stat"><span class="stat-label"><i class="dot dot-alive"></i>Alive</span><b class="stat-num">${counts.alive}</b></div>
    <div class="stat"><span class="stat-label"><i class="dot dot-due"></i>Due soon</span><b class="stat-num">${counts.due}</b></div>
    <div class="stat"><span class="stat-label"><i class="dot dot-dead"></i>Gone quiet</span><b class="stat-num">${counts.dead}</b></div>
    <div class="stat"><span class="stat-label">${history ? "Viewing block" : "Latest block"}</span><b class="stat-num mono">${state.block ? Number(history ? state.atBlock : state.block).toLocaleString("en-US") : "–"}</b></div>
  </section>
`
}

function boardStatus() {
  return state.atBlock !== undefined
    ? `${icon("history")}<span>Viewing history at block <b class="mono">${state.atBlock}</b>, read with an <code>atBlock</code> query.</span>`
    : `<i class="live-dot ${state.live ? "on" : ""}"></i><span>${state.live ? "Live over WebSocket" : "Polling"} · read straight from the public Tiramisu RPC</span>`
}

function boardBody() {
  const history = state.atBlock !== undefined
  return `
    ${state.error ? `<p class="notice notice-error">${esc(state.error)}</p>` : ""}
    ${
      state.loading
        ? `<div class="grid">${'<div class="card skeleton"></div>'.repeat(3)}</div>`
        : state.canaries.length
          ? `<div class="grid">${state.canaries.map(card).join("")}</div>`
          : `<div class="empty">${icon("layers")}<h3>No canaries${history ? " at this block" : " yet"}</h3><p>Be the first company to publish one.</p><a class="btn btn-primary btn-sm" href="#/publish">Publish a canary</a></div>`
    }
`
}

function viewBoard() {
  const history = state.atBlock !== undefined
  return `
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow"><i class="live-dot on"></i>Built on Arkiv · Tiramisu testnet</span>
      <h1>When a company goes quiet, <em>you'll know.</em></h1>
      <p class="lead">Tacet puts warrant canaries on Arkiv, the Web3 database. A company renews its canary from its own wallet.
      If it is gagged and stops, the canary expires by itself, and everyone can see it.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="#board">View live board ${icon("arrow")}</a>
        <a class="btn btn-ghost" href="#/how">How it works</a>
      </div>
      <ul class="trust">
        <li>${icon("server")}No backend</li>
        <li>${icon("key")}Verifiable by anyone</li>
        <li>${icon("eyeoff")}Anonymous to watch</li>
      </ul>
    </div>
    ${heroVisual}
  </section>

  <div id="dyn-stats">${boardStats()}</div>

  <section class="section" id="board">
    <div class="section-head">
      <div>
        <h2>Live board</h2>
        <p class="status-line" id="dyn-status">${boardStatus()}</p>
      </div>
      <form id="tm" class="tm" aria-label="Time machine">
        ${icon("history")}
        <input id="tm-block" inputmode="numeric" autocomplete="off" aria-label="Block number" placeholder="View at block…" value="${history ? state.atBlock : ""}" />
        <button class="btn btn-sm btn-dark" type="submit">Go</button>
        ${history ? `<button type="button" id="tm-live" class="btn btn-sm btn-ghost">Back to live</button>` : ""}
      </form>
    </div>
    <div id="dyn-body">${boardBody()}</div>
  </section>

  <section class="section">
    <div class="section-head"><div><h2>How Tacet works</h2><p class="muted">Three steps, and no one in the middle.</p></div></div>
    <ol class="steps">
      <li><span class="step-n">01</span><h3>Publish</h3><p>A company signs its canary from its own wallet: a promise, and a pulse that lives for one renewal period.</p></li>
      <li><span class="step-n">02</span><h3>Renew</h3><p>Every period it presses Renew. A Lifetime Extension pushes the pulse's expiry forward. Only its wallet can.</p></li>
      <li><span class="step-n">03</span><h3>Go quiet</h3><p>Gagged? It simply stops. Arkiv expires the pulse on its own, and every watcher sees the canary go red.</p></li>
    </ol>
  </section>`
}

function viewDetail(promiseKey: string) {
  const c = state.canaries.find((x) => x.promiseKey.toLowerCase() === promiseKey.toLowerCase())
  if (!c)
    return state.loading
      ? `<div class="page"><div class="card skeleton tall"></div></div>`
      : `<div class="page"><div class="empty">${icon("alert")}<h3>Canary not found at this block</h3><a class="btn btn-ghost btn-sm" href="#/">Back to board</a></div></div>`
  const trusted = reader
    .select({ key: true, expiresAt: true, creator: true })
    .where(eq("app", APP), eq("kind", "pulse"), eq("promise", key(c.promiseKey)))
    .createdBy(c.creator)
    .toString()
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "arkiv_query",
    params: [trusted, { select: { key: true, creator: true, expiresAt: true } }],
  })
  const rows: [string, string][] = [
    ["Promise entity", `<span class="mono">${c.promiseKey}</span>`],
    ["Creator (immutable)", addrLink(c.creator)],
    ["Promise created", `block <span class="mono">${c.promiseCreatedAt}</span>`],
    ["Promise expires", `block <span class="mono">${c.promiseExpiresAt}</span>`],
    ["Current pulse", c.pulse ? `<span class="mono">${c.pulse.key}</span>` : "None. Gone quiet"],
    [
      "Pulse created",
      c.pulse
        ? `block <span class="mono">${c.pulse.createdAt}</span> ${c.restarted ? '<span class="tag tag-warn">later than promise: restarted</span>' : '<span class="tag tag-ok">same as promise: never broke</span>'}`
        : "–",
    ],
    ["Pulse expires", c.pulse ? `block <span class="mono">${c.pulse.expiresAt}</span>` : "–"],
    ["Website", esc(c.website || "–")],
  ]
  return `
  <div class="page">
    <a class="back" href="#/">${icon("back")} Board</a>
    <section class="detail-hero card-${c.status}">
      <div class="detail-id">
        ${avatar(c, "avatar-lg")}
        <div class="detail-name">
          <h1>${esc(c.org)}</h1>
          <p class="sub">${esc(c.category)} · renews every ${fmtPeriod(c.periodSec)} · signed by ${addrLink(c.creator)}</p>
        </div>
        ${chip(c)}
      </div>
      <blockquote class="statement-lg">${esc(c.statement)}</blockquote>
      ${life(c, true)}
      ${flags(c)}
    </section>

    <div class="detail-grid">
      <section class="panel">
        <h2>${icon("key")} Verify it yourself</h2>
        <p class="muted">This site is only a viewer. Ask Arkiv directly. The query pins the <b>immutable creator</b>, so a renewal written by any other wallet never counts.</p>
        ${codeBlock("Query", trusted)}
        ${codeBlock("curl · public Tiramisu RPC", `curl -s ${RPC} -H 'content-type: application/json' -d '${body}'`)}
        <p class="hint">Empty result: the canary has gone quiet. A result with <code>expiresAt</code> after the current block: alive.</p>
        ${codeBlock("Watch from your terminal", `git clone ${REPO} && cd tacet && npm i\nnpm run watch -- ${c.promiseKey}`)}
      </section>
      <section class="panel">
        <h2>${icon("layers")} On-chain facts</h2>
        <dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
        <a class="btn btn-ghost btn-sm" href="${EXPLORER}/address/${c.creator}" target="_blank" rel="noopener">Open creator in explorer ${icon("external")}</a>
      </section>
    </div>
  </div>`
}

function viewPublish() {
  return `
  <div class="page">
    <div class="page-head">
      <span class="eyebrow">For companies</span>
      <h1>Publish a warrant canary</h1>
      <p class="lead">Your wallet becomes your identity. Only it can ever renew this canary. Use test data only.</p>
    </div>
    <div class="publish-grid">
      <section class="panel">
        <div class="step-head"><span class="step-n">1</span><h2>Connect your wallet</h2></div>
        ${
          account
            ? `<div class="connected">${icon("wallet")}<span>Connected as ${addrLink(account)}</span><span class="chip chip-alive"><i class="dot"></i>Tiramisu</span></div>`
            : `<button id="connect" class="btn btn-dark" type="button">${icon("wallet")} Connect wallet</button>
               <p class="hint">MetaMask or Rabby. We add the Tiramisu network for you. Need test GLM? Use the ${ext("https://hub.arkiv.network/faucet", "Arkiv faucet", "link")}.</p>`
        }
        <div class="step-head"><span class="step-n">2</span><h2>Describe your canary</h2></div>
        <form id="pub" class="form" ${account ? "" : "inert"}>
          <div class="form-row">
            <label>Organization name<input name="org" required maxlength="64" placeholder="Example VPN" /></label>
            <label>Category
              <select name="category"><option>vpn</option><option>email</option><option>cloud</option><option>messaging</option><option>other</option></select>
            </label>
          </div>
          <label>Statement
            <textarea name="statement" required maxlength="600" rows="3">We have not received any secret government order or gag order for user data. If this canary goes quiet, assume that is no longer true.</textarea>
          </label>
          <div class="form-row">
            <label>Website<input name="website" maxlength="120" placeholder="https://example.org" /></label>
            <label>Renew every
              <select name="period">${PERIODS.map((p) => `<option value="${p.seconds}">${p.label}</option>`).join("")}</select>
            </label>
          </div>
          <div class="step-head"><span class="step-n">3</span><h2>Publish</h2></div>
          <button class="btn btn-primary" type="submit">Publish canary ${icon("arrow")}</button>
          <p class="hint">One transaction creates the promise and its first pulse together.</p>
        </form>
        <div id="pub-msg" class="msg" role="status"></div>
      </section>
      <aside class="aside">
        <div class="panel panel-soft">
          <h3>What gets written</h3>
          <ul class="checks">
            <li>${icon("lock")}<span><b>Promise</b>: your statement and renewal period. Read-only, lives 90 days.</span></li>
            <li>${icon("clock")}<span><b>Pulse</b>: lives exactly one period. Only your wallet can extend it.</span></li>
            <li>${icon("eyeoff")}<span><b>Nothing personal.</b> No emails, no accounts, no user data.</span></li>
          </ul>
        </div>
        <div id="mine">${viewMine()}</div>
      </aside>
    </div>
  </div>`
}

function viewMine() {
  if (!account) return ""
  const mine = state.canaries.filter((c) => c.creator.toLowerCase() === account!.toLowerCase())
  return `<div class="panel">
    <h3>Your canaries</h3>
    ${
      mine.length
        ? `<ul class="mine-list">${mine
            .map(
              (c) => `
        <li class="mine">
          <div class="mine-id">${avatar(c, "avatar-sm")}<div><b>${esc(c.org)}</b><span class="sub">${
            c.status === "dead" ? "Gone quiet" : `due in <span class="mono" data-left="${c.secondsLeft}">${fmtDuration(c.secondsLeft)}</span>`
          }</span></div></div>
          ${
            c.pulse
              ? `<button class="btn btn-sm btn-dark" type="button" data-renew="${c.promiseKey}">Renew</button>`
              : `<button class="btn btn-sm btn-ghost" type="button" data-restart="${c.promiseKey}" title="The board will show this canary was restarted, forever">Restart</button>`
          }
        </li>`,
            )
            .join("")}</ul>`
        : `<p class="muted">None yet. Publish your first one.</p>`
    }
  </div>`
}

function viewHow() {
  return `
  <div class="page">
    <div class="page-head">
      <span class="eyebrow">How it works</span>
      <h1>Silence, made <em>verifiable.</em></h1>
      <p class="lead">A warrant canary is a line a company publishes: "We have not received a secret government order for your data."
      If it is gagged, it can't say so, but it can stop renewing. Tacet makes that silence impossible to fake or hide.</p>
    </div>

    <section class="story">
      <div class="panel">
        <h2>A real-life story</h2>
        <ol class="timeline">
          <li><span class="tl-dot"></span><div><b>A journalist uses a VPN</b> to talk to a whistleblower about a scandal.</div></li>
          <li><span class="tl-dot"></span><div><b>A secret order arrives.</b> The VPN must hand over data, and it is forbidden to tell anyone.</div></li>
          <li class="tl-bad"><span class="tl-dot"></span><div><b>Today:</b> the old canary stays up on the company's website. Nobody notices. A hacker could even keep changing its date.</div></li>
          <li class="tl-good"><span class="tl-dot"></span><div><b>With Tacet:</b> the company stops pressing Renew. Arkiv expires the canary on its own, the board turns red, and the journalist switches VPNs in time.</div></li>
        </ol>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><h2>Why it can't be faked</h2><p class="muted">Every guarantee comes from Arkiv itself, not from us.</p></div></div>
      <div class="features">
        <div class="feature">${icon("key")}<h3>Only the company can renew</h3><p>We filter on the immutable <code>$creator</code>, never the company name. A stranger's renewal is ignored.</p></div>
        <div class="feature">${icon("lock")}<h3>Nobody else can extend it</h3><p>Pulses are created with <code>permissionlessExtension</code> off. Not even whoever gagged the company can keep it alive.</p></div>
        <div class="feature">${icon("clock")}<h3>It dies on its own</h3><p>Entity Expiration is enforced by the network. No cron job, no keeper, no server has to act.</p></div>
        <div class="feature">${icon("restart")}<h3>Breaks are permanent</h3><p>Promise and first pulse are written in one atomic transaction. A younger pulse proves the canary broke.</p></div>
        <div class="feature">${icon("server")}<h3>Nothing to take down</h3><p>This site is static. Any Arkiv RPC answers the same query, with or without us.</p></div>
        <div class="feature">${icon("history")}<h3>Evidence outlives expiry</h3><p>The time machine replays the board at any past block with <code>atBlock</code> queries.</p></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><h2>Website canary vs. Tacet</h2></div></div>
      <div class="table-wrap">
        <table class="compare">
          <thead><tr><th></th><th>Canary on a website</th><th>Tacet</th></tr></thead>
          <tbody>
            <tr><td>A hacker fakes a renewal</td><td class="no">Possible</td><td class="yes">Ignored: wrong wallet</td></tr>
            <tr><td>Date quietly backdated</td><td class="no">Possible</td><td class="yes">Block time can't be edited</td></tr>
            <tr><td>Page taken down</td><td class="no">Canary gone</td><td class="yes">Any RPC still answers</td></tr>
            <tr><td>Goes stale unnoticed</td><td class="no">Common</td><td class="yes">Expires and turns red</td></tr>
            <tr><td>Someone keeps it alive for them</td><td class="no">Possible</td><td class="yes">Only the owner can extend</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="panel panel-soft">
        <h2>What we keep off Arkiv</h2>
        <ul class="checks">
          <li>${icon("key")}<span><b>Private keys</b> stay in the company's wallet.</span></li>
          <li>${icon("eyeoff")}<span><b>The people watching.</b> Watching is anonymous, needs no account, and writes nothing.</span></li>
          <li>${icon("layers")}<span><b>Legal documents.</b> The canary is only the signal.</span></li>
        </ul>
      </div>
    </section>
  </div>`
}

// ---------- render ----------

function render(full = true) {
  const r = route()
  // Background refreshes must not wipe a half-filled form.
  if (!full && r === "publish" && document.querySelector("#mine")) {
    document.querySelector("#mine")!.innerHTML = viewMine()
    bindMine()
    return
  }
  if (!full && (r === "" || r === "board") && document.querySelector("#dyn-body")) {
    document.querySelector("#dyn-stats")!.innerHTML = boardStats()
    document.querySelector("#dyn-status")!.innerHTML = boardStatus()
    document.querySelector("#dyn-body")!.innerHTML = boardBody()
    return
  }
  if (r.startsWith("c/")) app.innerHTML = viewDetail(r.slice(2))
  else if (r === "publish") app.innerHTML = viewPublish()
  else if (r === "how") app.innerHTML = viewHow()
  else app.innerHTML = viewBoard()
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]"))
    a.classList.toggle("on", a.dataset.nav === (r.startsWith("c/") ? "" : r))
  bind()
}

// ---------- actions ----------

async function connect() {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
  if (!eth) throw new Error("No browser wallet found. Install MetaMask or Rabby, then reload.")
  const [addr] = (await eth.request({ method: "eth_requestAccounts" })) as Hex[]
  const chainId = `0x${tiramisu.id.toString(16)}`
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId, chainName: "Arkiv Tiramisu", nativeCurrency: tiramisu.nativeCurrency, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }],
    })
  }
  account = addr
  wallet = createWalletClient({ chain: tiramisu, transport: custom(eth), account: addr })
}

function msg(html: string, kind: "info" | "ok" | "error" = "info") {
  const el = document.querySelector("#pub-msg")
  if (el) el.innerHTML = `<div class="notice notice-${kind}">${html}</div>`
}

function bind() {
  document.querySelector<HTMLFormElement>("#tm")?.addEventListener("submit", (e) => {
    e.preventDefault()
    const v = (document.querySelector<HTMLInputElement>("#tm-block")!.value || "").trim()
    if (!/^\d+$/.test(v)) return
    state.atBlock = BigInt(v)
    state.loading = true
    render()
    refresh()
  })
  document.querySelector("#tm-live")?.addEventListener("click", () => {
    state.atBlock = undefined
    state.loading = true
    render()
    refresh()
  })
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? "")
        b.innerHTML = `${icon("check")}<span>Copied</span>`
        setTimeout(() => (b.innerHTML = `${icon("copy")}<span>Copy</span>`), 1600)
      } catch {}
    })
  }
  document.querySelector("#connect")?.addEventListener("click", async () => {
    try {
      await connect()
      render()
    } catch (e) {
      alert(errText(e))
    }
  })
  document.querySelector<HTMLFormElement>("#pub")?.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!wallet || !account) return
    const f = new FormData(e.target as HTMLFormElement)
    const input = {
      org: String(f.get("org")).trim(),
      category: String(f.get("category")),
      statement: String(f.get("statement")).trim(),
      website: String(f.get("website") || "").trim(),
      periodSec: Number(f.get("period")),
    }
    msg("Confirm the transaction in your wallet…")
    try {
      const r = await publishCanary(reader, wallet, account, input)
      msg(`Published. Promise and first pulse created in one transaction ${txLink(r.txHash)}. <a class="link" href="#/c/${r.promiseKey}">View canary</a>`, "ok")
      await refresh()
    } catch (err) {
      msg(esc(errText(err)), "error")
    }
  })
  bindMine()
}

function bindMine() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-renew]")) {
    b.addEventListener("click", async () => {
      const c = state.canaries.find((x) => x.promiseKey === b.dataset.renew)
      if (!c?.pulse || !wallet) return
      b.disabled = true
      b.textContent = "Renewing…"
      try {
        const r = await wallet.extendEntity(renewParams(c.pulse.key, c.periodSec))
        msg(`Renewed ${esc(c.org)} with a Lifetime Extension ${txLink(r.txHash)}`, "ok")
        await refresh()
      } catch (err) {
        msg(esc(errText(err)), "error")
        b.disabled = false
        b.textContent = "Renew"
      }
    })
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-restart]")) {
    b.addEventListener("click", async () => {
      const c = state.canaries.find((x) => x.promiseKey === b.dataset.restart)
      if (!c || !wallet) return
      b.disabled = true
      try {
        const r = await wallet.createEntity(
          pulseParams(c.promiseKey, { org: c.org, category: c.category, statement: "", website: "", periodSec: c.periodSec }),
        )
        msg(`Restarted ${esc(c.org)} ${txLink(r.txHash)}. The board will show it went quiet before.`, "ok")
        await refresh()
      } catch (err) {
        msg(esc(errText(err)), "error")
        b.disabled = false
      }
    })
  }
}

// ---------- theme ----------

function themeIcon() {
  const dark = document.documentElement.dataset.theme === "dark"
  document.querySelector("#theme")!.innerHTML = icon(dark ? "sun" : "moon")
  return dark
}
document.querySelector("#theme")?.addEventListener("click", () => {
  const next = themeIcon() ? "light" : "dark"
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem("tacet-theme", next)
  } catch {}
  themeIcon()
})
themeIcon()

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest('a[href="#board"]')
  if (!a) return
  e.preventDefault()
  document.querySelector("#board")?.scrollIntoView({ behavior: "smooth" })
})

window.addEventListener("hashchange", () => {
  if (location.hash === "#board") return
  render()
  window.scrollTo({ top: 0 })
})
render()
refresh()
startLive()
