// Talaria, the Desktop half: this device's hands for Hermes.
//
// Says hello to the Talaria routes on the server every few seconds, signed with this device's
// Ed25519 key. When the server nudges a request at this device, it claims it, checks the path
// against this device's allowed folders, does the work through the stock app's native bridge
// (window.hermesDesktop), and posts a signed result. Nothing here trusts the server to have
// checked anything: the folder rules are enforced on this side.

import { host } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PROTOCOL = 'talaria/1'
const HELLO_EVERY_MS = 5_000
const MAX_OUTPUT_CHARS = 100_000
const MAX_LIST_ENTRIES = 1000

// ------------------------------------------------------------------ paths and folder rules

export function isWindowsPlatform(nav = globalThis.navigator) {
  const platform = String(nav?.userAgentData?.platform || nav?.platform || '')

  return /^win/i.test(platform)
}

// Normalise an absolute path to forward slashes with no `.`/`..`/empty segments. Returns null
// for anything that is not a plain absolute path (relative, `~`, UNC, device paths, `..` above root).
export function normalizePath(value, win) {
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

export function toNative(normalized, win) {
  return win ? normalized.replace(/\//g, '\\') : normalized
}

export function isWithin(normalized, roots, win) {
  const key = value => (win ? value.toLowerCase() : value)
  const target = key(normalized)

  return roots.some(root => {
    const r = key(root)

    return target === r || target.startsWith(r.endsWith('/') ? r : `${r}/`)
  })
}

export function parseRoots(text, win) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => normalizePath(line, win))
    .filter(Boolean)
}

// The path a request may touch, or an error naming why not.
export function allowedPath(value, roots, win) {
  if (!roots.length) {
    throw new Error('no allowed folders are set on this device (Settings → Plugins → Talaria)')
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

// ------------------------------------------------------------------ running a command in a pty

export function shellFamily(name) {
  const n = String(name || '').toLowerCase()

  if (n === 'ssh') {
    return 'ssh'
  }

  if (n.startsWith('pwsh') || n.startsWith('powershell')) {
    return 'powershell'
  }

  if (n.startsWith('cmd')) {
    return 'cmd'
  }

  return n.startsWith('fish') ? 'fish' : 'posix'
}

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

// One input line that prints a begin marker, runs the command, and prints an end marker with the
// exit code. The markers are split in the typed line, so the terminal's echo of what we typed never
// contains a whole marker; only the shell's real output does.
export function wrapCommand(command, id, family) {
  const b64 = utf8Base64(command)

  if (family === 'powershell') {
    return (
      `Write-Output ('__TALARIA_'+'BEGIN_${id}'); $global:LASTEXITCODE=0; ` +
      `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); ` +
      `$__talaria_ok=$?; $__talaria_rc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($__talaria_ok) { 0 } else { 1 }; ` +
      `Write-Output ('__TALARIA_'+'END_${id}:'+$__talaria_rc)\r`
    )
  }

  if (family === 'fish') {
    return (
      `printf '%s%s\\n' '__TALARIA_' 'BEGIN_${id}'; eval (printf %s '${b64}' | base64 -d | string collect); ` +
      `printf '\\n%s%s:%s\\n' '__TALARIA_' 'END_${id}' $status\r`
    )
  }

  return (
    `printf '%s%s\\n' '__TALARIA_' 'BEGIN_${id}'; eval "$(printf %s '${b64}' | base64 -d)"; ` +
    `printf '\\n%s%s:%s\\n' '__TALARIA_' 'END_${id}' "$?"\r`
  )
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function extractOutput(buffer, id) {
  const begin = `__TALARIA_BEGIN_${id}`
  const end = new RegExp(`__TALARIA_END_${id}:(-?\\d+)`)
  const clean = buffer.replace(ANSI, '').replace(/\r\n?/g, '\n')
  const start = clean.indexOf(begin)

  if (start < 0) {
    return null
  }

  const after = clean.slice(start + begin.length).replace(/^\n/, '')
  const match = end.exec(after)

  if (!match) {
    return null
  }

  return { exitCode: Number(match[1]), output: after.slice(0, match.index).replace(/\n+$/, '') }
}

function trimOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text
  }

  const half = MAX_OUTPUT_CHARS / 2

  return `${text.slice(0, half)}\n[output truncated]\n${text.slice(-half)}`
}

async function runCommand(bridge, { command, cwd, timeout }, roots, win, running, requestId) {
  const folder = allowedPath(cwd, roots, win)
  const terminal = bridge.terminal
  const started = await terminal.start({ cols: 200, cwd: toNative(folder, win), rows: 50 })
  const family = shellFamily(started?.shell)
  let disposeData = () => {}
  const stop = async () => {
    disposeData()
    running.delete(requestId)
    await terminal.dispose(started.id).catch(() => {})
  }

  if (family === 'ssh') {
    await stop()
    throw new Error('this window is connected over SSH, so its terminal runs on the server; refusing')
  }

  if (family === 'cmd') {
    await stop()
    throw new Error('cmd.exe is not supported; install PowerShell or set HERMES_DESKTOP_SHELL')
  }

  // The app falls back to the home folder if the folder is missing; never run somewhere else.
  const actual = normalizePath(started?.cwd, win)

  if (!actual || (win ? actual.toLowerCase() !== folder.toLowerCase() : actual !== folder)) {
    await stop()
    throw new Error(`folder does not exist on this device: ${cwd}`)
  }

  const id = Math.random().toString(36).slice(2, 12)
  let buffer = ''

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      await terminal.write(started.id, '\x03').catch(() => {})
      await stop()
      resolve({ exit_code: null, output: trimOutput(buffer.replace(ANSI, '')), shell: started.shell, timed_out: true })
    }, timeout * 1000)

    running.set(requestId, async () => {
      clearTimeout(timer)
      await stop()
      reject(new Error('cancelled by the server'))
    })

    disposeData = terminal.onData(started.id, chunk => {
      buffer += String(chunk ?? '')

      const done = extractOutput(buffer, id)

      if (done) {
        clearTimeout(timer)
        stop().then(() =>
          resolve({ exit_code: done.exitCode, output: trimOutput(done.output), shell: started.shell, timed_out: false })
        )
      }
    })

    Promise.resolve(terminal.attach(started.id))
      .then(() => terminal.write(started.id, wrapCommand(command, id, family)))
      .catch(async error => {
        clearTimeout(timer)
        await stop()
        reject(error)
      })
  })
}

// ------------------------------------------------------------------ operations

export async function perform(bridge, op, args, roots, win, running, requestId) {
  if (op === 'list') {
    const folder = allowedPath(args.path, roots, win)
    const res = await bridge.readDir(toNative(folder, win))

    if (res?.error) {
      throw new Error(`could not list ${args.path}: ${res.error}`)
    }

    const entries = (res?.entries || []).slice(0, MAX_LIST_ENTRIES)

    for (const entry of entries) {
      const resolved = normalizePath(entry.path, win)

      if (!resolved || !isWithin(resolved, roots, win)) {
        throw new Error(`${args.path} resolves outside this device's allowed folders`)
      }
    }

    return {
      entries: entries.map(e => ({ name: e.name, type: e.isDirectory ? 'dir' : 'file' })),
      path: args.path,
      truncated: (res?.entries || []).length > MAX_LIST_ENTRIES
    }
  }

  if (op === 'read') {
    const file = allowedPath(args.path, roots, win)
    const res = await bridge.readFileText(toNative(file, win))

    if (!res || typeof res.text !== 'string') {
      throw new Error(`could not read ${args.path}: ${res?.error || res?.reason || 'not found'}`)
    }

    const resolved = normalizePath(res.path, win)

    if (!resolved || !isWithin(resolved, roots, win)) {
      throw new Error(`${args.path} resolves outside this device's allowed folders`)
    }

    if (res.binary) {
      throw new Error(`${args.path} is a binary file`)
    }

    return { path: args.path, size: res.byteSize, text: res.text, truncated: Boolean(res.truncated) }
  }

  if (op === 'write') {
    const file = allowedPath(args.path, roots, win)
    const res = await bridge.writeTextFile(toNative(file, win), String(args.content ?? ''))

    return { path: args.path, written: Boolean(res?.path) }
  }

  if (op === 'run') {
    return runCommand(bridge, args, roots, win, running, requestId)
  }

  throw new Error(`unknown operation ${op}`)
}

// ------------------------------------------------------------------ identity and envelopes

function b64(bytes) {
  let binary = ''

  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function unb64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0))
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function loadIdentity(storage, subtle = globalThis.crypto.subtle) {
  let saved = storage.get('identity', null)

  if (!saved?.privateKey || !saved?.publicKey) {
    const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    saved = {
      privateKey: b64(await subtle.exportKey('pkcs8', pair.privateKey)),
      publicKey: b64(await subtle.exportKey('raw', pair.publicKey))
    }
    storage.set('identity', saved)
  }

  const privateKey = await subtle.importKey('pkcs8', unb64(saved.privateKey), { name: 'Ed25519' }, false, ['sign'])
  const deviceId = hex(await subtle.digest('SHA-256', unb64(saved.publicKey))).slice(0, 32)

  return { deviceId, privateKey, publicKey: saved.publicKey }
}

export async function envelope(identity, kind, payload, subtle = globalThis.crypto.subtle) {
  const text = JSON.stringify(payload)
  const ts = Date.now()
  const nonce = hex(globalThis.crypto.getRandomValues(new Uint8Array(12)))
  const digest = hex(await subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const message = [PROTOCOL, kind, identity.deviceId, String(ts), nonce, digest].join('\n')
  const sig = await subtle.sign({ name: 'Ed25519' }, identity.privateKey, new TextEncoder().encode(message))
  const env = { device_id: identity.deviceId, kind, nonce, payload: text, sig: b64(sig), ts, v: 1 }

  if (kind === 'hello') {
    env.public_key = identity.publicKey
  }

  return env
}

// ------------------------------------------------------------------ the device loop

function defaultName(win) {
  return win ? 'windows-desktop' : 'this-device'
}

function Settings({ ctx, status }) {
  const win = isWindowsPlatform()
  const [name, setName] = useState(() => ctx.storage.get('name', defaultName(win)))
  const [roots, setRoots] = useState(() => ctx.storage.get('roots', ''))
  const saved = parseRoots(roots, win)
  const field = 'w-full rounded border border-(--ui-border) bg-transparent px-2 py-1 text-sm'

  return jsxs('div', {
    className: 'flex max-w-xl flex-col gap-4 p-4 text-sm',
    children: [
      jsxs('label', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('span', { className: 'font-medium', children: 'Device name' }),
          jsx('input', {
            className: field,
            onChange: e => setName(e.target.value),
            onBlur: () => ctx.storage.set('name', name.trim().toLowerCase()),
            value: name
          }),
          jsx('span', {
            className: 'text-(--ui-text-tertiary)',
            children: 'Lowercase letters, digits and dashes. Athena uses this name to aim at this device.'
          })
        ]
      }),
      jsxs('label', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('span', { className: 'font-medium', children: 'Allowed folders (one per line)' }),
          jsx('textarea', {
            className: `${field} min-h-28 font-mono`,
            onChange: e => setRoots(e.target.value),
            onBlur: () => ctx.storage.set('roots', roots),
            value: roots
          }),
          jsx('span', {
            className: 'text-(--ui-text-tertiary)',
            children: `Talaria refuses any path outside these. ${saved.length} folder(s) in force. Empty means nothing is allowed.`
          })
        ]
      }),
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: status() })
    ]
  })
}

export default {
  id: 'talaria',
  name: 'Talaria',
  defaultEnabled: false,
  register(ctx) {
    const bridge = window.hermesDesktop
    const win = isWindowsPlatform()
    const running = new Map()
    const inflight = new Set()
    const sessions = new Map()
    let identity = null
    let lastStatus = 'Starting.'
    let disposed = false

    const roots = () => parseRoots(ctx.storage.get('roots', ''), win)
    const claimSession = sessionId => {
      if (sessionId) {
        sessions.set(sessionId, Date.now())
      }

      if (sessions.size > 20) {
        sessions.delete([...sessions.entries()].sort((a, b) => a[1] - b[1])[0][0])
      }
    }

    const handle = async requestId => {
      if (inflight.has(requestId)) {
        return
      }

      inflight.add(requestId)

      try {
        let request

        try {
          request = await ctx.rest('/claim', { body: await envelope(identity, 'claim', { request_id: requestId }), method: 'POST' })
        } catch {
          return // another window of this app claimed it, or it expired
        }

        let reply

        try {
          const result = await perform(bridge, request.op, request.args || {}, roots(), win, running, requestId)
          reply = { digest: request.digest, ok: true, request_id: requestId, result }

          if (result?.shell) {
            ctx.storage.set('shell', result.shell)
          }
        } catch (error) {
          reply = { digest: request.digest, error: String(error?.message || error), ok: false, request_id: requestId }
        }

        await ctx.rest('/result', { body: await envelope(identity, 'result', reply), method: 'POST' })
      } finally {
        inflight.delete(requestId)
      }
    }

    const hello = async () => {
      if (disposed || !identity) {
        return
      }

      try {
        const name = ctx.storage.get('name', defaultName(win))
        const payload = {
          name,
          platform: win ? 'windows' : String(globalThis.navigator?.platform || ''),
          roots: roots().map(r => toNative(r, win)),
          sessions: [...sessions.entries()].map(([session_id, at]) => ({ at, session_id })),
          shell: ctx.storage.get('shell', '')
        }
        const res = await ctx.rest('/hello', { body: await envelope(identity, 'hello', payload), method: 'POST' })
        const key = identity.deviceId.slice(0, 8)

        lastStatus =
          res.approved === false
            ? `Waiting for approval as ${res.name} (key ${key}). In a chat, type: /talaria approve ${res.name} ${key}`
            : `Online as ${res.name} (key ${key}).`

        for (const requestId of res.pending || []) {
          handle(requestId)
        }
      } catch (error) {
        lastStatus = `Not connected: ${String(error?.message || error)}`
      }
    }

    ctx.registerSettingsPage?.({
      icon: 'rocket',
      id: 'settings',
      render: () => jsx(Settings, { ctx, status: () => lastStatus }),
      title: 'Talaria'
    })

    ctx.onEvent('plugin.talaria.request', event => {
      const p = event?.payload || {}

      if (identity && p.device_id === identity.deviceId) {
        handle(p.request_id)
      }
    })

    ctx.onEvent('plugin.talaria.cancel', event => {
      const p = event?.payload || {}

      if (identity && p.device_id === identity.deviceId) {
        running.get(p.request_id)?.()
      }
    })

    // "The device this conversation was last used from": the chat focused here, and any chat that
    // starts a turn while focused here (a message sent from this window).
    const focused = host.state.focusedSessionId
    const busy = host.state.busyBySession
    const unsubscribeFocus = focused.subscribe(id => {
      claimSession(id)
      hello()
    })
    const unsubscribeBusy = busy.subscribe(map => {
      const id = focused.get()

      if (id && map?.[id]) {
        claimSession(id)
        hello()
      }
    })

    ctx.onDispose(() => {
      disposed = true
      unsubscribeFocus()
      unsubscribeBusy()

      for (const cancel of running.values()) {
        cancel()
      }
    })

    ctx.setInterval(hello, HELLO_EVERY_MS)
    loadIdentity(ctx.storage)
      .then(loaded => {
        identity = loaded
        hello()
      })
      .catch(error => {
        lastStatus = `Could not create this device's key: ${String(error?.message || error)}`
      })
  }
}
