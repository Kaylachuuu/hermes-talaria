// Run: node --test talaria/tests/js/helper.test.mjs (the end-to-end helper tests are in test_in_hermes.py)
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import {
  Dashboard, allowedOrigin, envelope, newIdentity, normalizePath, openIdentity, shellFor
} from '../../../helper/talaria-helper.mjs'
import { probeHelper } from '../../desktop/plugin.js'

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
