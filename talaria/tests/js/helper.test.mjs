// Run: node --test talaria/tests/js/helper.test.mjs (the end-to-end helper tests are in test_in_hermes.py)
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import {
  Dashboard, OikosLink, Screen, allowedOrigin, applySettings, browserCandidates, envelope, installOptions, sendKeysFor, sendKeysText, webUrl, newIdentity, normalizePath, openIdentity, shellFor
} from '../../../helper/talaria-helper.mjs'
import {
  gatewayAddress, helperCall, helperCommand, helperPlan, probeHelper, readHelperToken
} from '../../desktop/plugin.js'

test('the helper and the Desktop plugin share the path rules', () => {
  assert.equal(normalizePath('/Users/k/./a/../b', false), '/Users/k/b')
  assert.equal(normalizePath('c:\\Users\\K\\..\\K', true), 'C:/Users/K')
  assert.equal(normalizePath('relative', false), null)
})

test('only the Desktop app and local pages may talk to the helper', () => {
  for (const ok of [undefined, 'null', 'file://', 'app://hermes', 'http://localhost:5173', 'http://127.0.0.1:3000']) {
    assert.ok(allowedOrigin(ok), ok)
  }

  for (const bad of ['https://example.com', 'http://10.1.0.98:9119', 'not a url']) {
    assert.ok(!allowedOrigin(bad), bad)
  }
})

test('PowerShell gets the command encoded, with its exit code carried out', () => {
  const shell = shellFor('win32', {}, () => '')
  assert.equal(shell.exe, 'powershell.exe')
  const args = shell.args(`Write-Output "it's \\"quoted\\""`)
  assert.equal(args[2], '-EncodedCommand')
  const script = Buffer.from(args[3], 'base64').toString('utf16le')
  assert.ok(script.includes(`Write-Output "it's \\"quoted\\""`))
  assert.ok(script.includes('exit $LASTEXITCODE'))
  assert.equal(shellFor('darwin', {}).exe, '/bin/zsh')
  assert.deepEqual(shellFor('linux', { SHELL: '/usr/bin/fish' }).args('ls'), ['-l', '-c', 'ls'])
})

test('a helper envelope verifies with the public key it sends', () => {
  const identity = openIdentity(newIdentity())
  const env = envelope(identity, 'hello', { name: 'x' })
  const raw = Buffer.from(env.public_key, 'base64')
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32), env.device_id)
  const digest = crypto.createHash('sha256').update(env.payload).digest('hex')
  const message = ['talaria/1', 'hello', env.device_id, String(env.ts), env.nonce, digest].join('\n')
  const key = crypto.createPublicKey({ format: 'der', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki' })
  assert.ok(crypto.verify(null, Buffer.from(message), key, Buffer.from(env.sig, 'base64')))
})

test('the dashboard session cookies are kept, rotated and dropped', () => {
  const saved = []
  const dash = new Dashboard('http://x/', { cookies: { a: '1' } }, value => saved.push(structuredClone(value)))
  const res = cookies => ({ headers: { getSetCookie: () => cookies } })
  dash.keepCookies(res(['b=2; Path=/; HttpOnly', 'a=1; Path=/']))
  assert.deepEqual(dash.secrets.cookies, { a: '1', b: '2' })
  dash.keepCookies(res(['a=; Max-Age=0; Path=/']))
  assert.deepEqual(dash.secrets.cookies, { b: '2' })
  assert.equal(saved.length, 2)
  assert.equal(dash.headers().cookie, 'b=2')
})

test('the Desktop plugin finds the helper, or falls back when it is not running', async () => {
  const running = async url => ({ json: async () => ({ name: 'mac', status: 'Online' }), ok: url.endsWith('/status') })
  assert.deepEqual(await probeHelper(running), { name: 'mac', status: 'Online' })
  assert.equal(await probeHelper(async () => { throw new Error('ECONNREFUSED') }), null)
})

test('settings from Desktop are checked before the helper keeps them', () => {
  const config = { folders: ['/a'], local_port: 1, name: 'mac', server: 'http://h:1' }
  assert.deepEqual(applySettings(config, { folders: [' /b ', '', '/c'], name: ' MacBook ', server: 'http://10.1.0.98:9119/' }),
    { folders: ['/b', '/c'], local_port: 1, name: 'macbook', server: 'http://10.1.0.98:9119' })
  assert.deepEqual(applySettings(config, {}), config)
  assert.throws(() => applySettings(config, { folders: ['relative'] }), /absolute/)
  assert.throws(() => applySettings(config, { name: 'has space' }), /lowercase/)
  assert.throws(() => applySettings(config, { server: 'ftp://h' }), /http/)
})

test('Desktop reads the local token and sends it with every settings call', async () => {
  const paths = []
  const bridge = { readFileText: async p => { paths.push(p); return { text: 'abc123\n' } } }
  assert.equal(await readHelperToken('/Users/k/Library/Application Support/Talaria', false, bridge), 'abc123')
  assert.equal(await readHelperToken('C:\\Users\\k\\AppData\\Roaming\\Talaria', true, bridge), 'abc123')
  assert.deepEqual(paths, ['/Users/k/Library/Application Support/Talaria/local-token',
    'C:\\Users\\k\\AppData\\Roaming\\Talaria\\local-token'])
  assert.equal(await readHelperToken('/x', false, undefined), '')

  const seen = []
  const fetchFn = async (url, init) => {
    seen.push([url, init.method, init.headers['x-talaria-token'], init.body])
    return url.endsWith('/bad')
      ? { json: async () => ({ error: 'nope' }), ok: false, status: 400 }
      : { json: async () => ({ name: 'mac' }), ok: true, status: 200 }
  }
  assert.deepEqual(await helperCall('/config', 'tok', undefined, fetchFn), { name: 'mac' })
  await helperCall('/config', 'tok', { name: 'x' }, fetchFn)
  await assert.rejects(helperCall('/bad', 'tok', {}, fetchFn), /nope/)
  assert.deepEqual(seen[0], ['http://127.0.0.1:47219/config', 'GET', 'tok', undefined])
  assert.deepEqual(seen[1], ['http://127.0.0.1:47219/config', 'POST', 'tok', '{"name":"x"}'])
})

test('the helper takes the app\'s name, folders and dashboard address', () => {
  const current = { folders: ['/Users/k/code'], name: 'mac', server: 'http://h:1' }
  assert.deepEqual(helperPlan(current, { folders: ['/Users/k/code/'], name: 'mac', server: '' }, false), { adopt: null, change: null })
  assert.deepEqual(helperPlan(current, { folders: ['/Users/k/docs'], name: 'macbook', server: 'http://10.1.0.98:9119' }, false),
    { adopt: null, change: { folders: ['/Users/k/docs'], name: 'macbook', server: 'http://10.1.0.98:9119' } })
  // An app with no folders yet takes the ones the helper was set up with.
  assert.deepEqual(helperPlan(current, { folders: [], name: 'mac', server: '' }, false), { adopt: ['/Users/k/code'], change: null })
  assert.deepEqual(helperPlan({ folders: ['C:\\Users\\K'] }, { folders: ['c:/users/k'], name: '', server: '' }, true), { adopt: null, change: null })
})

test('Install and Remove run the helper\'s own commands', async () => {
  assert.equal(helperCommand('/Users/k/.talaria-helper-setup.mjs', 'install', 'http://10.1.0.98:9119'),
    'node "/Users/k/.talaria-helper-setup.mjs" install --remove-source --server "http://10.1.0.98:9119"')
  assert.equal(helperCommand('C:\\Users\\K\\AppData\\Roaming\\Talaria\\talaria-helper.mjs', 'uninstall'),
    'node "C:\\Users\\K\\AppData\\Roaming\\Talaria\\talaria-helper.mjs" uninstall')
  assert.deepEqual(installOptions(['--server', 'http://h:1', '--remove-source']), { removeSource: true, server: 'http://h:1' })
  assert.throws(() => installOptions(['--bogus']), /unknown/)
  const bridge = config => ({ getConnectionConfig: async () => config })
  assert.equal(await gatewayAddress(bridge({ mode: 'remote', remoteUrl: 'http://10.1.0.98:9119/' })), 'http://10.1.0.98:9119')
  assert.equal(await gatewayAddress(bridge({ mode: 'local', remoteUrl: 'http://x:1' })), '')
  assert.equal(await gatewayAddress(undefined), '')
})

test('browser addresses are web pages only', () => {
  assert.equal(webUrl('example.com/a'), 'https://example.com/a')
  assert.throws(() => webUrl('file:///etc/passwd'), /only http/)
  assert.throws(() => webUrl('javascript:alert(1)'), /only http/)
  assert.throws(() => webUrl('https://me:pw@example.com'), /password/)
  assert.ok(browserCandidates('firefox', 'win32', { PROGRAMFILES: 'C:\\Program Files' })[0].endsWith('Mozilla Firefox\\firefox.exe'))
  assert.deepEqual(browserCandidates('safari', 'darwin'), ['/usr/bin/safaridriver'])
  assert.deepEqual(applySettings({}, { browser: true, browser_app: 'edge', screen: 'yes' }), { browser: true, browser_app: 'edge', screen: false })
  assert.throws(() => applySettings({}, { browser_app: 'netscape' }), /must be one of/)
})

test('screen coordinates map from the screenshot back to the screen', () => {
  const screen = new Screen('/tmp', 'win32')
  assert.throws(() => screen.toScreen([1, 1]), /screenshot first/)
  screen.geometry = { height: 2160, imageHeight: 720, imageWidth: 1280, width: 3840, x: 0, y: 0 }
  assert.deepEqual(screen.toScreen([640, 360]), [1920, 1080])
  assert.throws(() => screen.toScreen([1300, 10]), /inside the 1280x720/)
  assert.equal(sendKeysFor('ctrl+shift+s'), '^+s')
  assert.equal(sendKeysFor('enter'), '{ENTER}')
  assert.equal(sendKeysFor('alt+F4'), '%{F4}')
  assert.equal(sendKeysText('50% (off) {x}+1'), '50{%} {(}off{)} {{}x{}}{+}1')
})

test('on Oikos the helper signs in with its key, says what it allows, and signs each result as written', async () => {
  const identity = openIdentity(newIdentity())
  const sent = []
  let socket
  class FakeSocket {
    constructor (url) { this.url = url; this.on = {}; socket = this }
    addEventListener (kind, fn) { this.on[kind] = fn }
    send (text) { sent.push(JSON.parse(text)) }
    close () { this.on.close({ reason: 'test' }) }
  }
  const helper = {
    abilities: () => ['files'],
    config: { name: 'macbook', oikos: 'ws://oikos:11600' },
    identity,
    roots: () => ['/Users/k/Notes'],
    shell: { name: 'zsh' },
    work: async (op, args) => ({ entries: [{ name: 'a.md', type: 'file' }], path: args.path, size: 1.5e-7 })
  }
  const link = new OikosLink(helper, { log: () => {}, WebSocketImpl: FakeSocket })
  const closed = link.connect()
  assert.equal(socket.url, 'ws://oikos:11600')
  const said = data => socket.on.message({ data: JSON.stringify(data) })
  const tick = () => new Promise(resolve => setTimeout(resolve, 10))
  const raw = Buffer.from(identity.publicKey, 'base64')
  const publicKey = crypto.createPublicKey({ format: 'der', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki' })
  const verify = (kind, nonce, payload, ts, sig) => crypto.verify(null, Buffer.from(['oikos/1', kind, identity.deviceId, String(ts), nonce,
    crypto.createHash('sha256').update(payload, 'utf8').digest('hex')].join('\n')), publicKey, Buffer.from(sig, 'base64'))

  said({ jsonrpc: '2.0', method: 'event', params: { payload: { challenge: 'c'.repeat(32) }, type: 'gateway.hello' } })
  await tick()
  const signIn = sent.at(-1)
  assert.equal(signIn.method, 'gateway.sign_in')
  assert.deepEqual(signIn.params.enroll, { name: 'macbook', public_key: identity.publicKey, space: 'private' })
  assert.ok(verify('sign_in', 'c'.repeat(32), '', signIn.params.ts, signIn.params.signature))
  said({ id: signIn.id, jsonrpc: '2.0', result: { device: 'macbook', person: 'kayla' } })
  await tick()
  const offer = sent.at(-1)
  assert.equal(offer.method, 'device.offer')
  assert.deepEqual(offer.params.roots, ['/Users/k/Notes'])
  said({ id: offer.id, jsonrpc: '2.0', result: { offered: true } })
  await tick()
  assert.match(link.status, /online as macbook \(kayla's\)/)

  said({ id: 's1', jsonrpc: '2.0', method: 'device.request', params: { args: { path: '/Users/k/Notes' }, digest: 'd'.repeat(64), op: 'list', request_id: 'r1' } })
  await tick()
  const answer = sent.at(-1)
  assert.equal(answer.id, 's1')
  assert.equal(JSON.parse(answer.result.result_text).size, 1.5e-7)
  assert.ok(verify('result', answer.result.nonce, `${'d'.repeat(64)}\n${answer.result.result_text}`, answer.result.ts, answer.result.signature))

  helper.work = async () => { throw new Error('/etc is outside the allowed folders') }
  said({ id: 's2', jsonrpc: '2.0', method: 'device.request', params: { args: { path: '/etc' }, digest: 'e'.repeat(64), op: 'list', request_id: 'r2' } })
  await tick()
  assert.equal(sent.at(-1).error.data.reason, 'refused')
  assert.match(sent.at(-1).error.message, /outside the allowed folders/)
  socket.close()
  assert.equal(await closed, 'test')
})
