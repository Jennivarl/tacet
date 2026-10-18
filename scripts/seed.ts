// Seeds the board with SYNTHETIC demo canaries (fictional companies, no personal data).
//   npm run seed            -> everything below
// Needs PRIVATE_KEY (company wallet, funded from the Tiramisu faucet) in .env.
// Creates IMPOSTER_KEY in .env on first run and funds it from the company wallet.
import "dotenv/config"
import { appendFileSync } from "node:fs"
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http, parseEther, formatEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  makePublicClient,
  publishCanary,
  pulseParams,
  renewParams,
  type PublishInput,
} from "../src/lib/canary"
import { ExpirationTime } from "@arkiv-network/sdk"

const reader = makePublicClient()
const pk = process.env.PRIVATE_KEY as Hex | undefined
if (!pk) throw new Error("Set PRIVATE_KEY in .env")
const company = privateKeyToAccount(pk)
const wallet = createWalletClient({ chain: tiramisu, transport: http(), account: company })

let impKey = process.env.IMPOSTER_KEY as Hex | undefined
if (!impKey) {
  impKey = generatePrivateKey()
  appendFileSync(".env", `IMPOSTER_KEY=${impKey}\n`)
}
const imposter = privateKeyToAccount(impKey)
const impWallet = createWalletClient({ chain: tiramisu, transport: http(), account: imposter })

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

log("company wallet ", company.address, formatEther(await reader.getBalance({ address: company.address })), "GLM")
log("imposter wallet", imposter.address)

const STATEMENT = (org: string) =>
  `${org} has not received any National Security Letter, gag order, or secret request for user data. ` +
  `If this canary goes quiet, assume that is no longer true.`

const demo: Record<string, PublishInput> = {
  fennec: {
    org: "Fennec VPN",
    category: "vpn",
    statement: STATEMENT("Fennec VPN"),
    website: "https://fennec-vpn.example",
    periodSec: 7 * 86400,
  },
  owlpost: {
    org: "Owlpost Mail",
    category: "email",
    statement: STATEMENT("Owlpost Mail"),
    website: "https://owlpost.example",
    periodSec: 86400,
  },
  harbor: {
    org: "Harbor Cloud",
    category: "cloud",
    statement: STATEMENT("Harbor Cloud"),
    website: "https://harbor-cloud.example",
    periodSec: 120,
  },
  kite: {
    org: "Kite Chat",
    category: "messaging",
    statement: STATEMENT("Kite Chat"),
    website: "https://kite-chat.example",
    periodSec: 120,
  },
}

// 1. Healthy canaries.
const fennec = await publishCanary(reader, wallet, company.address, demo.fennec)
log("Fennec VPN   promise", fennec.promiseKey, "tx", fennec.txHash)
const owlpost = await publishCanary(reader, wallet, company.address, demo.owlpost)
log("Owlpost Mail promise", owlpost.promiseKey)

// 2. Harbor Cloud: 2-minute canary that is never renewed -> goes quiet.
const harbor = await publishCanary(reader, wallet, company.address, demo.harbor)
log("Harbor Cloud promise", harbor.promiseKey, "(will go quiet in ~2 min)")

// 3. Kite Chat: goes quiet, then the company restarts it -> flagged RESTARTED forever.
const kite = await publishCanary(reader, wallet, company.address, demo.kite)
log("Kite Chat    promise", kite.promiseKey, "(will die, then restart)")

// 4. Renew Fennec once: Lifetime Extension resets the clock.
await wallet.extendEntity(renewParams(fennec.pulseKey, demo.fennec.periodSec))
log("Renewed Fennec VPN pulse")

// 5. Fund the imposter and spoof.
const funding = await wallet.sendTransaction({ to: imposter.address, value: parseEther("0.02") })
await reader.waitForTransactionReceipt({ hash: funding })
log("Funded imposter")
const fake = await publishCanary(reader, impWallet, imposter.address, {
  ...demo.fennec,
  statement: STATEMENT("Fennec VPN") + " (totally legit, trust us)",
})
log("Imposter 'Fennec VPN' promise", fake.promiseKey)

// 6. Wait for Harbor + Kite to expire.
log("Waiting ~140s for the 2-minute canaries to expire…")
await sleep(140_000)

// The imposter tries to keep Harbor Cloud looking alive by writing a pulse that points at it.
// It is ignored because its $creator is not Harbor's creator.
const spoof = await impWallet.createEntity(pulseParams(harbor.promiseKey, { ...demo.harbor, periodSec: 30 * 86400 }))
log("Spoofed Harbor pulse", spoof.entityKey)

// Kite restarts with a fresh pulse, then extends it so it stays visible through judging.
const restarted = await wallet.createEntity(pulseParams(kite.promiseKey, demo.kite))
await wallet.extendEntity({ entityKey: restarted.entityKey, expires: ExpirationTime.fromDays(30) })
log("Kite Chat restarted with pulse", restarted.entityKey)

log("Done. Creator wallets: company", company.address, "imposter", imposter.address)
