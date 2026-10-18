// Prints the Tiramisu head block, the Tacet canary count and the seed wallets' balances.
//   npm run status
import "dotenv/config"
import { formatEther, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { headInfo, loadCanaries, makePublicClient } from "../src/lib/canary"

const client = makePublicClient()
const head = await headInfo(client)
const { canaries } = await loadCanaries(client)
console.log(`Tiramisu block ${head.block} (${head.blockSeconds}s/block), ${canaries.length} canaries`)

for (const name of ["PRIVATE_KEY", "IMPOSTER_KEY"]) {
  const pk = process.env[name] as Hex | undefined
  if (!pk) continue
  const { address } = privateKeyToAccount(pk)
  console.log(`${name.padEnd(12)} ${address} ${formatEther(await client.getBalance({ address }))} GLM`)
}
