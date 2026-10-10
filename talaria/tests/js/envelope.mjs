// Prints a signed hello envelope from plugin.js's own code, for the Python interop test.
import { envelope, loadIdentity } from '../../desktop/plugin.js'

const store = new Map()
const storage = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) }
const identity = await loadIdentity(storage)
const hello = await envelope(identity, 'hello', { name: 'node-device', roots: ['/tmp'], sessions: [] })
const claim = await envelope(identity, 'claim', { request_id: 'r1' })
console.log(JSON.stringify({ claim, hello }))
