// Tacet CLI watcher. Talks straight to the public Tiramisu RPC, no Tacet server.
//   npm run watch                 -> every canary
//   npm run watch -- 0xPROMISEKEY -> one canary
import "dotenv/config"
import { fmtDuration, isRateLimited, loadCanaries, makePublicClient, makeSocketClient, short, type Status } from "../src/lib/canary"

const only = process.argv[2]?.toLowerCase()
const reader = makePublicClient()
const last = new Map<string, Status>()
const icon = { alive: "🟢 ALIVE   ", due: "🟡 DUE SOON", dead: "🔴 QUIET   " }

async function tick(reason: string) {
  const { canaries, block } = await loadCanaries(reader)
  const list = canaries.filter((c) => !only || c.promiseKey.toLowerCase() === only)
  console.log(`\n[block ${block}] ${reason}`)
  for (const c of list) {
    const was = last.get(c.promiseKey)
    if (was && was !== "dead" && c.status === "dead") {
      process.stdout.write("\x07")
      console.log(`🚨 ALARM: ${c.org} (${short(c.creator)}) stopped renewing its canary.`)
    }
    last.set(c.promiseKey, c.status)
    const left = c.status === "dead" ? "no renewal" : `renew due in ${fmtDuration(c.secondsLeft)}`
    const flags = [
      c.restarted && "restarted",
      c.spoofedPulses && `${c.spoofedPulses} fake pulse(s) ignored`,
      c.nameClaimedBy.length && "name claimed by another wallet",
    ].filter(Boolean)
    console.log(`${icon[c.status]} ${c.org.padEnd(16)} ${short(c.creator)}  ${left}${flags.length ? "  ⚠ " + flags.join(", ") : ""}`)
  }
}

await tick("start")
// Expiry emits no event, so we also poll; renewals and new canaries arrive over the WebSocket.
setInterval(() => tick("poll").catch((e) => console.error(isRateLimited(e) ? "Rate limited by the public RPC, retrying next minute" : e)), 60_000)
let pending: NodeJS.Timeout | undefined
makeSocketClient().watchEntityEvents({
  onEvent: (e) => {
    clearTimeout(pending)
    pending = setTimeout(() => tick(`event ${e.type}`).catch(console.error), 1500)
  },
  onError: (err) => console.error("socket:", err.message),
})
