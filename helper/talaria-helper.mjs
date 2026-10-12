#!/usr/bin/env node
// Talaria helper: this machine's hands for Hermes, without the Desktop app open.
//
// The same device protocol as the Desktop plugin (docs/protocol.md), run as a small background
// service: it says hello to the Talaria routes on the dashboard every two seconds, signed with this
// machine's Ed25519 key, claims requests aimed at it, checks every path against its allowed folders
// (after resolving symlinks), does the work with Node's own file and process APIs, and posts a
// signed result. Nothing here trusts the server to have checked anything.
//
// Hermes Desktop, when it runs on the same machine, hands this helper the chats it shows (through
// 127.0.0.1) so "the device this conversation was last used from" still works, and stops doing the
// work itself.
//
//   talaria-helper setup        first-time setup: server, sign-in, name, folders
//   talaria-helper run          run in the foreground (what the background service runs)
//   talaria-helper install      run it in the background at login, from a copy of this file
//   talaria-helper uninstall    stop that
//   talaria-helper status       is it running, and as which device
//   talaria-helper login        sign in to the dashboard again
//   talaria-helper folders [add <path> | remove <path>]
//
// Node 18 or later, and nothing else.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.2.0'
const PROTOCOL = 'talaria/1'
const HELLO_EVERY_MS = 2_000
const DEFAULT_LOCAL_PORT = 47219
const MAX_OUTPUT_CHARS = 100_000
const MAX_LIST_ENTRIES = 1000
const MAX_READ_BYTES = 512 * 1024
const MAX_WRITE_CHARS = 1_000_000
const SERVICE_LABEL = 'com.kaylachuuu.talaria-helper'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'TalariaHelper'
const WIN = process.platform === 'win32'

// ------------------------------------------------------------------ paths and folder rules
// The same rules as desktop/plugin.js, plus a check of the real path after symlinks.

// Normalise an absolute path to forward slashes with no `.`/`..`/empty segments. Returns null for
// anything that is not a plain absolute path (relative, `~`, UNC, device paths, `..` above root).
export function normalizePath(value, win = WIN) {
  let raw = String(value ?? '').trim()

  if (!raw || raw.includes('\0')) {
    return null
  }

  if (win) {
    raw = raw.replace(/\\/g, '/')

    if (!/^[A-Za-z]:\//.test(raw)) {
      return null
    }
  } else if (!raw.startsWith('/')) {
    return null
  }

  const [head, ...rest] = win ? [raw.slice(0, 2).toUpperCase(), ...raw.slice(3).split('/')] : ['', ...raw.slice(1).split('/')]
  const out = []

  for (const segment of rest) {
    if (segment === '' || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (!out.length) {
        return null
      }

      out.pop()
      continue
    }

    out.push(segment)
  }

  return `${head}/${out.join('/')}`
}

export function toNative(normalized, win = WIN) {
  return win ? normalized.replace(/\//g, '\\') : normalized
}

export function isWithin(normalized, roots, win = WIN) {
  const key = value => (win ? value.toLowerCase() : value)
  const target = key(normalized)

  return roots.some(root => {
    const r = key(root)

    return target === r || target.startsWith(r.endsWith('/') ? r : `${r}/`)
  })
}

export function parseRoots(list, win = WIN) {
  return (list || []).map(line => normalizePath(line, win)).filter(Boolean)
}

// The path a request may touch, or an error naming why not.
export function allowedPath(value, roots, win = WIN) {
  if (!roots.length) {
    throw new Error('no allowed folders are set on this device (talaria-helper folders add <path>)')
  }

  const normalized = normalizePath(value, win)

  if (!normalized) {
    throw new Error(`not an absolute path on this device: ${value}`)
  }

  if (!isWithin(normalized, roots, win)) {
    throw new Error(`outside this device's allowed folders: ${value}`)
  }

  return normalized
}

// The allowed folders as they really are on disk (e.g. /tmp is /private/tmp on a Mac).
async function realRoots(roots, win) {
  const real = await Promise.all(roots.map(r => fsp.realpath(toNative(r, win)).catch(() => null)))

  return real.map(r => r && normalizePath(r, win)).filter(Boolean)
}

// Throws unless `normalized`, with every symlink resolved, is still inside an allowed folder.
async function realInside(normalized, roots, win, original) {
  const real = normalizePath(await fsp.realpath(toNative(normalized, win)), win)

  if (!real || !isWithin(real, await realRoots(roots, win), win)) {
    throw new Error(`${original} resolves outside this device's allowed folders`)
  }

  return real
}

// ------------------------------------------------------------------ operations

function trimOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text
  }

  const half = MAX_OUTPUT_CHARS / 2

  return `${text.slice(0, half)}\n[output truncated]\n${text.slice(-half)}`
}

function onPath(command) {
  const finder = WIN ? 'where.exe' : 'which'
  const found = spawnSync(finder, [command], { encoding: 'utf8', windowsHide: true })

  return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : ''
}

// The shell commands run in, and how to hand it one command.
export function shellFor(platform = process.platform, env = process.env, find = onPath) {
  if (platform === 'win32') {
    const exe = find('pwsh.exe') || 'powershell.exe'

    // Encoded, so no quoting survives the trip; the exit code follows the last native command,
    // else whether the last cmdlet succeeded.
    const wrap = command =>
      [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
        '$global:LASTEXITCODE=0',
        command,
        '$__ok=$?',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($__ok) { exit 0 } else { exit 1 }'
      ].join('\n')

    return {
      args: command => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrap(command), 'utf16le').toString('base64')],
      exe,
      name: path.win32.basename(exe)
    }
  }

  const exe = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')

  // A login shell, so PATH matches a terminal's (Homebrew and so on).
  return { args: command => ['-l', '-c', command], exe, name: path.posix.basename(exe) }
}

function killTree(child) {
  if (WIN) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })

    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }, 2000).unref()
  } catch {
    // Already gone.
  }
}

async function runCommand({ command, cwd, timeout }, roots, win, shell) {
  const folder = allowedPath(cwd, roots, win)
  const stat = await fsp.stat(toNative(folder, win)).catch(() => null)

  if (!stat?.isDirectory()) {
    throw new Error(`folder does not exist on this device: ${cwd}`)
  }

  const real = await realInside(folder, roots, win, cwd)
  const seconds = Math.max(1, Math.min(120, Number(timeout) || 30))

  return new Promise((resolve, reject) => {
    let output = ''
    let timedOut = false
    const child = spawn(shell.exe, shell.args(String(command ?? '')), {
      cwd: toNative(real, win),
      detached: !win,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const keep = chunk => {
      output += chunk.toString('utf8')

      // Keep the head and a generous tail while it streams; trimOutput makes the final cut.
      if (output.length > MAX_OUTPUT_CHARS * 4) {
        output = trimOutput(output)
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, seconds * 1000)

    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', error => {
      clearTimeout(timer)
      reject(new Error(`could not start ${shell.name}: ${error.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({
        exit_code: timedOut ? null : code,
        output: trimOutput(output.replace(/\r\n?/g, '\n').replace(/\n+$/, '')),
        shell: shell.name,
        timed_out: timedOut
      })
    })
  })
}

export async function perform(op, args, roots, { win = WIN, shell = null } = {}) {
  if (op === 'list') {
    const folder = allowedPath(args.path, roots, win)
    await realInside(folder, roots, win, args.path)
    const entries = await fsp.readdir(toNative(folder, win), { withFileTypes: true }).catch(error => {
      throw new Error(`could not list ${args.path}: ${error.code || error.message}`)
    })

    return {
      entries: entries.slice(0, MAX_LIST_ENTRIES).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file'
      })),
      path: args.path,
      truncated: entries.length > MAX_LIST_ENTRIES
    }
  }

  if (op === 'read') {
    const file = allowedPath(args.path, roots, win)
    const real = await realInside(file, roots, win, args.path).catch(error => {
      throw error.code ? new Error(`could not read ${args.path}: ${error.code}`) : error
    })
    const handle = await fsp.open(toNative(real, win), 'r')

    try {
      const { size } = await handle.stat()
      const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, bytesRead)

      if (bytes.subarray(0, 8192).includes(0)) {
        throw new Error(`${args.path} is a binary file`)
      }

      return { path: args.path, size, text: bytes.toString('utf8'), truncated: size > bytesRead }
    } finally {
      await handle.close()
    }
  }

  if (op === 'write') {
    const file = allowedPath(args.path, roots, win)
    const content = String(args.content ?? '')

    if (content.length > MAX_WRITE_CHARS) {
      throw new Error(`content is over ${MAX_WRITE_CHARS} characters`)
    }

    // The folder must exist and really be inside; so must an existing file a symlink points to.
    const parent = normalizePath(path.posix.dirname(file), win) || file
    await realInside(parent, roots, win, args.path).catch(error => {
      throw error.code ? new Error(`folder does not exist on this device: ${toNative(parent, win)}`) : error
    })
    const existing = await fsp.lstat(toNative(file, win)).catch(() => null)

    if (existing?.isSymbolicLink()) {
      await realInside(file, roots, win, args.path)
    }

    await fsp.writeFile(toNative(file, win), content, 'utf8')

    return { path: args.path, written: true }
  }

  if (op === 'run') {
    return runCommand(args, roots, win, shell || shellFor())
  }

  throw new Error(`unknown operation ${op}`)
}

// ------------------------------------------------------------------ identity and envelopes

export function newIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')

  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  }
}

export function openIdentity(saved) {
  const raw = Buffer.from(saved.publicKey, 'base64')

  return {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32),
    key: crypto.createPrivateKey({ format: 'der', key: Buffer.from(saved.privateKey, 'base64'), type: 'pkcs8' }),
    publicKey: saved.publicKey
  }
}

export function envelope(identity, kind, payload) {
  const text = JSON.stringify(payload)
  const ts = Date.now()
  const nonce = crypto.randomBytes(12).toString('hex')
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  const message = [PROTOCOL, kind, identity.deviceId, String(ts), nonce, digest].join('\n')
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), identity.key).toString('base64')
  const env = { device_id: identity.deviceId, kind, nonce, payload: text, sig, ts, v: 1 }

  if (kind === 'hello') {
    env.public_key = identity.publicKey
  }

  return env
}

// ------------------------------------------------------------------ where things are kept

export function helperHome(env = process.env) {
  if (env.TALARIA_HELPER_HOME) {
    return env.TALARIA_HELPER_HOME
  }

  if (WIN) {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Talaria')
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Talaria')
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'talaria')
}

function configPath(home) {
  return path.join(home, 'config.json')
}

export function readConfig(home) {
  try {
    return JSON.parse(fs.readFileSync(configPath(home), 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`)
}

// The device key and the dashboard sign-in. In the login keychain on a Mac, protected with the
// user's Windows account (DPAPI) on Windows, else a file only this user can read.
export function secretStore(home, env = process.env) {
  const kind = env.TALARIA_HELPER_SECRETS || (process.platform === 'darwin' ? 'keychain' : WIN ? 'dpapi' : 'file')

  if (kind === 'keychain') {
    const where = ['-s', 'talaria-helper', '-a', 'secrets']

    return {
      kind,
      load() {
        const res = spawnSync('security', ['find-generic-password', ...where, '-w'], { encoding: 'utf8' })

        return res.status === 0 ? JSON.parse(res.stdout.trim()) : {}
      },
      save(value) {
        // Through stdin (security -i), so the secret never shows in the process list.
        const hex = Buffer.from(JSON.stringify(value), 'utf8').toString('hex')
        const res = spawnSync('security', ['-i'], {
          encoding: 'utf8',
          input: `add-generic-password -U ${where.join(' ')} -X ${hex}\n`
        })

        if (res.status !== 0) {
          throw new Error(`could not save to the keychain: ${res.stderr.trim()}`)
        }
      }
    }
  }

  if (kind === 'dpapi') {
    const file = path.join(home, 'secrets.dpapi')
    const dpapi = (direction, input) => {
      const call = direction === 'protect' ? 'Protect' : 'Unprotect'
      const script =
        'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); ' +
        `$out=[Security.Cryptography.ProtectedData]::${call}([Convert]::FromBase64String($in),$null,'CurrentUser'); ` +
        '[Convert]::ToBase64String($out)'
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        input,
        windowsHide: true
      })

      if (res.status !== 0) {
        throw new Error(`could not ${direction} the secrets: ${res.stderr.trim()}`)
      }

      return res.stdout.trim()
    }

    return {
      kind,
      load() {
        if (!fs.existsSync(file)) {
          return {}
        }

        const plain = dpapi('unprotect', fs.readFileSync(file, 'utf8'))

        return JSON.parse(Buffer.from(plain, 'base64').toString('utf8'))
      },
      save(value) {
        fs.mkdirSync(home, { recursive: true })
        fs.writeFileSync(file, dpapi('protect', Buffer.from(JSON.stringify(value)).toString('base64')))
      }
    }
  }

  const file = path.join(home, 'secrets.json')

  return {
    kind: 'file',
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return {}
      }
    },
    save(value) {
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    }
  }
}

// ------------------------------------------------------------------ the dashboard

export class SignedOut extends Error {}

// "a=1; Path=/; HttpOnly, b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT" -> each cookie, for runtimes
// without Headers.getSetCookie().
function splitSetCookie(header) {
  return header ? header.split(/,(?=\s*[^;,=\s]+=)/) : []
}

export class Dashboard {
  constructor(server, secrets, saveSecrets) {
    this.server = String(server || '').replace(/\/+$/, '')
    this.secrets = secrets
    this.saveSecrets = saveSecrets
  }

  headers() {
    const headers = { 'content-type': 'application/json' }
    const cookies = Object.entries(this.secrets.cookies || {})

    if (cookies.length) {
      headers.cookie = cookies.map(([k, v]) => `${k}=${v}`).join('; ')
    }

    if (this.secrets.token) {
      headers['X-Hermes-Session-Token'] = this.secrets.token
    }

    return headers
  }

  // The dashboard rotates its sign-in through cookies; keep whatever it sets.
  keepCookies(res) {
    const lines = res.headers.getSetCookie?.() ?? splitSetCookie(res.headers.get('set-cookie'))
    let changed = false

    for (const line of lines) {
      const [pair, ...attrs] = line.split(';')
      const at = pair.indexOf('=')

      if (at < 1) {
        continue
      }

      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      const gone = !value || attrs.some(a => /^\s*max-age\s*=\s*0\s*$/i.test(a))
      this.secrets.cookies = this.secrets.cookies || {}

      if (gone) {
        changed = name in this.secrets.cookies || changed
        delete this.secrets.cookies[name]
      } else if (this.secrets.cookies[name] !== value) {
        this.secrets.cookies[name] = value
        changed = true
      }
    }

    if (changed) {
      this.saveSecrets(this.secrets)
    }
  }

  async call(method, pathname, body) {
    const res = await fetch(`${this.server}${pathname}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: this.headers(),
      method,
      redirect: 'manual'
    })
    this.keepCookies(res)
    const text = await res.text()
    let data = null

    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }

    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      throw new SignedOut('signed out of the dashboard; run: talaria-helper login')
    }

    if (!res.ok) {
      const detail = data?.detail || text.slice(0, 200) || res.statusText
      throw new Error(`${pathname}: ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
    }

    return data
  }

  async login(username, password) {
    const providers = await this.call('GET', '/api/auth/providers').catch(() => null)
    const provider = providers?.providers?.find(p => p.supports_password)?.name

    if (!provider) {
      throw new Error('this dashboard has no username and password sign-in')
    }

    this.secrets.cookies = {}
    await this.call('POST', '/auth/password-login', { password, provider, username }).catch(error => {
      throw error instanceof SignedOut ? new Error('the dashboard refused that username and password') : error
    })

    if (!Object.keys(this.secrets.cookies).length) {
      throw new Error('signed in, but the dashboard set no session')
    }
  }
}

// ------------------------------------------------------------------ the device loop

export class Helper {
  constructor(home, { log = console.log, store = null } = {}) {
    this.home = home
    this.log = log
    this.store = store || secretStore(home)
    this.secrets = this.store.load()

    if (!this.secrets.identity) {
      this.secrets.identity = newIdentity()
      this.store.save(this.secrets)
    }

    this.identity = openIdentity(this.secrets.identity)
    this.localToken = localToken(home)
    this.sessions = new Map()
    this.inflight = new Set()
    this.status = 'Starting.'
    this.shell = shellFor()
  }

  get config() {
    return readConfig(this.home)
  }

  dashboard() {
    return new Dashboard(this.config.server, this.secrets, value => this.store.save(value))
  }

  roots() {
    return parseRoots(this.config.folders)
  }

  // A chat Hermes Desktop on this machine just showed or sent from.
  claimSession(sessionId, at = Date.now()) {
    if (!sessionId || at > Date.now() + 5000) {
      return
    }

    const id = String(sessionId).slice(0, 128)

    if (at > (this.sessions.get(id) || 0)) {
      this.sessions.set(id, at)
    }

    while (this.sessions.size > 20) {
      this.sessions.delete([...this.sessions.entries()].sort((a, b) => a[1] - b[1])[0][0])
    }
  }

  async hello() {
    const config = this.config
    const payload = {
      name: String(config.name || '').trim().toLowerCase(),
      platform: WIN ? 'windows' : process.platform,
      roots: this.roots().map(r => toNative(r)),
      sessions: [...this.sessions.entries()].map(([session_id, at]) => ({ at, session_id })),
      shell: this.shell.name
    }
    const key = this.identity.deviceId.slice(0, 8)

    try {
      const res = await this.dashboard().call('POST', '/api/plugins/talaria/hello', envelope(this.identity, 'hello', payload))
      this.status =
        res.approved === false
          ? `Waiting for approval as ${res.name} (key ${key}). In a chat, type: /talaria approve ${res.name} ${key}`
          : `Online as ${res.name} (key ${key}).`

      for (const requestId of res.pending || []) {
        this.handle(requestId)
      }
    } catch (error) {
      this.status = `Not connected: ${error.message}`
    }

    return this.status
  }

  async handle(requestId) {
    if (this.inflight.has(requestId)) {
      return
    }

    this.inflight.add(requestId)

    try {
      const dash = this.dashboard()
      const request = await dash.call('POST', '/api/plugins/talaria/claim', envelope(this.identity, 'claim', { request_id: requestId }))
      let reply

      try {
        const result = await perform(request.op, request.args || {}, this.roots(), { shell: this.shell })
        reply = { digest: request.digest, ok: true, request_id: requestId, result }
      } catch (error) {
        reply = { digest: request.digest, error: String(error?.message || error), ok: false, request_id: requestId }
      }

      this.log(`${request.op} ${reply.ok ? 'done' : `refused: ${reply.error}`}`)
      await dash.call('POST', '/api/plugins/talaria/result', envelope(this.identity, 'result', reply))
    } catch (error) {
      this.log(`request ${requestId.slice(0, 8)}: ${error.message}`)
    } finally {
      this.inflight.delete(requestId)
    }
  }

  // 127.0.0.1 only, for Hermes Desktop on this machine: what this helper is, and which chats the
  // app shows. Pages in a browser are turned away (see allowedOrigin).
  serveLocal(port = Number(this.config.local_port) || DEFAULT_LOCAL_PORT) {
    const server = http.createServer((req, res) => {
      const origin = req.headers.origin
      const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')

      if (!hostOk || !allowedOrigin(origin)) {
        res.writeHead(403).end()

        return
      }

      const cors = {
        'Access-Control-Allow-Headers': 'content-type, x-talaria-token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Private-Network': 'true'
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end()

        return
      }

      const send = (status, body) => {
        res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body))
      }

      const readBody = handler => {
        let body = ''

        req.on('data', chunk => {
          body += chunk

          if (body.length > 64_000) {
            req.destroy()
          }
        })
        req.on('end', async () => {
          let parsed

          try {
            parsed = JSON.parse(body || '{}')
          } catch {
            send(400, { error: 'bad body' })

            return
          }

          try {
            send(200, await handler(parsed))
          } catch (error) {
            send(400, { error: error.message })
          }
        })
      }
      const presented = Buffer.from(String(req.headers['x-talaria-token'] || ''))
      const expected = Buffer.from(this.localToken)
      const trusted = presented.length === expected.length && crypto.timingSafeEqual(presented, expected)

      if (req.method === 'GET' && req.url === '/status') {
        send(200, {
          home: this.home,
          key: this.identity.deviceId.slice(0, 8),
          name: this.config.name,
          status: this.status,
          version: VERSION
        })

        return
      }

      if (req.method === 'POST' && req.url === '/sessions') {
        readBody(body => {
          for (const claim of body.sessions || []) {
            this.claimSession(claim?.session_id, Number(claim?.at) || Date.now())
          }

          return { ok: true }
        })

        return
      }

      // Settings and sign-in, for Desktop's settings page only (it holds the local token).
      if (['/config', '/login'].includes(req.url) && !trusted) {
        send(403, { error: 'the local token is missing or wrong' })

        return
      }

      if (req.method === 'GET' && req.url === '/config') {
        const { folders = [], name = '', server = '' } = this.config
        send(200, { folders, name, server })

        return
      }

      if (req.method === 'POST' && req.url === '/config') {
        readBody(async change => {
          const next = applySettings(this.config, change)
          writeConfig(this.home, next)
          this.log('settings changed from Hermes Desktop')

          return { folders: next.folders || [], name: next.name, server: next.server, status: await this.hello() }
        })

        return
      }

      if (req.method === 'POST' && req.url === '/login') {
        readBody(async ({ password, username }) => {
          await this.dashboard().login(String(username || ''), String(password || ''))
          this.log('signed in again from Hermes Desktop')

          return { status: await this.hello() }
        })

        return
      }

      send(404, { error: 'not found' })
    })

    server.on('error', error => this.log(`local port ${port}: ${error.message}`))
    server.listen(port, '127.0.0.1')

    return server
  }

  async run() {
    this.serveLocal()
    let last = ''

    for (;;) {
      const status = await this.hello()

      if (status !== last) {
        this.log(status)
        last = status
      }

      await new Promise(resolve => setTimeout(resolve, HELLO_EVERY_MS))
    }
  }
}

// Changing the helper's settings over its local port needs this token. It is a file only this user
// can read, which Hermes Desktop reads through its own file bridge; other programs and web pages
// cannot present it.
export function localToken(home) {
  const file = path.join(home, 'local-token')

  try {
    const token = fs.readFileSync(file, 'utf8').trim()

    if (token.length >= 32) {
      return token
    }
  } catch {
    // Made below.
  }

  const token = crypto.randomBytes(24).toString('hex')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })

  return token
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

// A settings change from Desktop, checked the same way setup checks it. Returns the new config.
export function applySettings(config, change) {
  const next = { ...config }

  if (change.name !== undefined) {
    const name = String(change.name).trim().toLowerCase()

    if (!NAME_RE.test(name)) {
      throw new Error('the name must be lowercase letters, digits and dashes, up to 32')
    }

    next.name = name
  }

  if (change.folders !== undefined) {
    const folders = (Array.isArray(change.folders) ? change.folders : []).map(f => String(f).trim()).filter(Boolean)
    const bad = folders.find(f => !normalizePath(f))

    if (bad) {
      throw new Error(`not an absolute path on this machine: ${bad}`)
    }

    next.folders = folders
  }

  if (change.server !== undefined) {
    const server = String(change.server).trim().replace(/\/+$/, '')

    if (!/^https?:\/\/[^\s/]+$/.test(server)) {
      throw new Error('the dashboard address looks like http://host:port')
    }

    next.server = server
  }

  return next
}

// Hermes Desktop loads from file:// or its own scheme, or from localhost in development. Any web
// page's http(s) origin is refused, so a site cannot read this helper's name or fake chat focus.
export function allowedOrigin(origin) {
  if (!origin || origin === 'null') {
    return true
  }

  try {
    const url = new URL(origin)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return true
    }

    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ the command line

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

    if (hidden) {
      rl._writeToOutput = text => {
        if (text.includes(question)) {
          process.stdout.write(text)
        }
      }
    }

    rl.question(question, answer => {
      rl.close()

      if (hidden) {
        process.stdout.write('\n')
      }

      resolve(answer.trim())
    })
  })
}

async function signIn(helper, server) {
  const config = { ...helper.config, server }
  writeConfig(helper.home, config)
  const username = process.env.TALARIA_USERNAME || (await ask('Dashboard username: '))
  const password = process.env.TALARIA_PASSWORD || (await ask('Dashboard password: ', { hidden: true }))
  await helper.dashboard().login(username, password)
  console.log(`Signed in. The password is not kept; the dashboard's session is (${helper.store.kind}).`)
}

async function setup(helper) {
  const config = helper.config
  const server = (await ask(`Dashboard address [${config.server || 'http://10.1.0.98:9119'}]: `)) || config.server || 'http://10.1.0.98:9119'
  const fallback = config.name || os.hostname().toLowerCase().replace(/\..*$/, '').replace(/[^a-z0-9-]/g, '-').slice(0, 32)
  const name = ((await ask(`Device name [${fallback}]: `)) || fallback).toLowerCase()
  const folders = [...(config.folders || [])]

  console.log('Folders Athena may use on this machine, one per line; an empty line ends the list.')

  for (const folder of folders) {
    console.log(`  ${folder}`)
  }

  for (;;) {
    const folder = await ask('Folder: ')

    if (!folder) {
      break
    }

    if (!normalizePath(folder)) {
      console.log('  That is not an absolute path; skipped.')
      continue
    }

    folders.push(folder)
  }

  writeConfig(helper.home, { ...config, folders, name, server })
  await signIn(helper, server)
  console.log(await helper.hello())
  console.log('Next: talaria-helper install, to keep it running in the background.')
}

function scriptPath() {
  return fileURLToPath(import.meta.url)
}

function install(helper) {
  const target = path.join(helper.home, 'talaria-helper.mjs')
  fs.mkdirSync(helper.home, { recursive: true })

  if (path.resolve(scriptPath()) !== path.resolve(target)) {
    fs.copyFileSync(scriptPath(), target)
  }

  const node = process.execPath

  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    const log = path.join(os.homedir(), 'Library', 'Logs', 'talaria-helper.log')
    const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(target)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
    )
    const domain = `gui/${process.getuid()}`
    spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`])
    const res = spawnSync('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' })

    if (res.status !== 0) {
      throw new Error(`launchctl: ${res.stderr.trim()}`)
    }

    console.log(`Running in the background at login (log: ${log}).`)

    return
  }

  if (WIN) {
    // The per-user Run key starts it at login and needs no administrator rights. Hidden PowerShell
    // starts node, so no console window stays open.
    const command = `powershell.exe -NoProfile -WindowStyle Hidden -Command "& '${node}' '${target}' run"`
    const res = spawnSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f'], {
      encoding: 'utf8',
      windowsHide: true
    })

    if (res.status !== 0) {
      throw new Error(`reg: ${(res.stderr || res.stdout).trim()}`)
    }

    stopWindowsHelper()
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `& '${node}' '${target}' run`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
    console.log('Running in the background, and at every login.')

    return
  }

  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'talaria-helper.service')
  fs.mkdirSync(path.dirname(unit), { recursive: true })
  fs.writeFileSync(
    unit,
    `[Unit]\nDescription=Talaria helper\n\n[Service]\nExecStart="${node}" "${target}" run\nRestart=always\n\n[Install]\nWantedBy=default.target\n`
  )
  spawnSync('systemctl', ['--user', 'daemon-reload'])
  spawnSync('systemctl', ['--user', 'enable', '--now', 'talaria-helper.service'])
  console.log('Running in the background at login (systemd user service talaria-helper).')
}

// Any running helper of this user's, found by its command line.
function stopWindowsHelper() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*talaria-helper.mjs*run*' -and $_.ProcessId -ne $PID } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
}

function uninstall() {
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`])
    fs.rmSync(plist, { force: true })
  } else if (WIN) {
    spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true })
    stopWindowsHelper()
  } else {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'talaria-helper.service'])
  }

  console.log('Stopped, and it will not start at login. Settings and the device key are kept.')
}

async function status(helper) {
  const port = Number(helper.config.local_port) || DEFAULT_LOCAL_PORT

  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    console.log(`Running. ${body.status}`)
  } catch {
    console.log('Not running.')
  }

  console.log(`Settings: ${configPath(helper.home)}`)
  console.log(`Folders: ${(helper.config.folders || []).join(', ') || 'none'}`)
}

function folders(helper, action, folder) {
  const config = helper.config
  let list = [...(config.folders || [])]

  if (action === 'add' && folder) {
    if (!normalizePath(folder)) {
      throw new Error(`not an absolute path: ${folder}`)
    }

    list.push(folder)
  } else if (action === 'remove' && folder) {
    const target = normalizePath(folder)
    list = list.filter(f => normalizePath(f) !== target)
  }

  if (action) {
    writeConfig(helper.home, { ...config, folders: list })
  }

  console.log(list.length ? list.join('\n') : 'No folders: nothing is allowed.')
}

async function main(argv) {
  const [command = 'help', ...rest] = argv
  const home = helperHome()

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(fs.readFileSync(scriptPath(), 'utf8').split('\n').slice(13, 21).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))

    return
  }

  if (command === 'uninstall') {
    uninstall()

    return
  }

  const helper = new Helper(home)

  switch (command) {
    case 'setup':
      return setup(helper)
    case 'login':
      return signIn(helper, helper.config.server || (await ask('Dashboard address: ')))
    case 'run':
      return helper.run()
    case 'install':
      return install(helper)
    case 'status':
      return status(helper)
    case 'folders':
      return folders(helper, rest[0], rest[1])
    default:
      throw new Error(`unknown command ${command}; try: talaria-helper help`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath())) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Stopped: ${error.message}`)
    process.exit(1)
  })
}
