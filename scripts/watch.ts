// Tacet CLI watcher. Talks straight to the public Tiramisu RPC, no Tacet server.
//   npm run watch                 -> every canary
//   npm run watch -- 0xPROMISEKEY -> one canary
import "dotenv/config"
import { fmtDuration, isRateLimited, loadCanaries, makePublicClient, makeSocketClient, short, type Status } from "../src/lib/canary"

const only = process.argv[2]?.toLowerCase()
const reader = makePublicClient()
const last = new Map<string, Status>()
const icon = { alive: "🟢 ALIVE   ", due: "🟡 DUE SOON", dead: "🔴 QUIET   " }
let known = new Set<string>()
let lastPrinted = ""

async function tick(reason: string) {
  const { canaries, block } = await loadCanaries(reader)
  const list = canaries.filter((c) => !only || c.promiseKey.toLowerCase() === only)
  known = new Set(list.flatMap((c) => [c.promiseKey.toLowerCase(), ...(c.pulse ? [c.pulse.key.toLowerCase()] : [])]))
  const lines: string[] = []
  for (const c of list) {
    const was = last.get(c.promiseKey)
    if (was && was !== "dead" && c.status === "dead") {
      process.stdout.write(String.fromCharCode(7)) // terminal bell
      lines.push(`🚨 ALARM: ${c.org} (${short(c.creator)}) stopped renewing its canary.`)
    }
    last.set(c.promiseKey, c.status)
    const left = c.status === "dead" ? "no renewal" : `renew due in ${fmtDuration(c.secondsLeft)}`
    const flags = [
      c.restarted && "restarted",
      c.spoofedPulses && `${c.spoofedPulses} fake renewal(s) blocked`,
      c.laterClaim ? "possible imposter" : c.nameClaimedBy.length && "name shared",
    ].filter(Boolean)
    lines.push(`${icon[c.status]} ${c.org.padEnd(16)} ${short(c.creator)}  ${left.padEnd(22)}${flags.length ? "⚠ " + flags.join(", ") : ""}`)
  }
  // Only reprint when a status, a flag or the list itself changed (countdowns are left out).
  const signature = list
    .map((c) => [c.promiseKey, c.status, c.restarted, c.spoofedPulses, c.laterClaim, c.nameClaimedBy.length].join(":"))
    .join("|")
  if (signature === lastPrinted) return
  lastPrinted = signature
  console.log("")
  console.log(`[block ${block}] ${reason}`)
  for (const l of lines) console.log(l)
}

await tick("start")
// Expiry emits no event, so we also poll once a minute.
setInterval(() => tick("poll").catch((e) => console.error(isRateLimited(e) ? "Rate limited by the public RPC, retrying next minute" : e)), 60_000)
// The socket carries every app's events: react at once to ours, and to new entities at most once a minute.
let pending: NodeJS.Timeout | undefined
let lastCreated = 0
makeSocketClient().watchEntityEvents({
  onEvent: (e) => {
    const ours = known.has(e.entityKey.toLowerCase())
    if (!ours && !(e.type === "EntityCreated" && Date.now() - lastCreated > 60_000)) return
    if (!ours) lastCreated = Date.now()
    clearTimeout(pending)
    pending = setTimeout(() => tick(ours ? `${e.type} on a watched canary` : "new entities on Arkiv").catch(console.error), 1500)
  },
  onError: (err) => console.error("socket:", err.message),
})
