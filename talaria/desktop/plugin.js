// Talaria, the Desktop half: this device's hands for Hermes.
//
// Says hello to the Talaria routes on the server every few seconds, signed with this device's
// Ed25519 key. When the server nudges a request at this device, it claims it, checks the path
// against this device's allowed folders, does the work through the stock app's native bridge
// (window.hermesDesktop), and posts a signed result. Nothing here trusts the server to have
// checked anything: the folder rules are enforced on this side.

import { host } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PROTOCOL = 'talaria/1'
const HELLO_EVERY_MS = 5_000
const MAX_OUTPUT_CHARS = 100_000
const MAX_LIST_ENTRIES = 1000
// The background helper (helper/talaria-helper.mjs) listens here when it runs on this machine.
const HELPER_URL = 'http://127.0.0.1:47219'
const HELPER_LOG = win =>
  win ? '~/AppData/Roaming/Talaria/helper.log'
    : /Mac/.test(globalThis.navigator?.platform || '') ? '~/Library/Application Support/Talaria/helper.log' : '~/.config/talaria/helper.log'

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

// A computer name as a device name: "ANUBIS" -> "anubis", "Kaylas-MacBook.local" -> "kaylas-macbook".
export function deviceNameFrom(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\..*$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

// The renderer cannot ask the OS for the computer's name, so ask a shell of the app's own.
async function computerName(bridge, win) {
  const terminal = bridge?.terminal

  if (!terminal) {
    return ''
  }

  const started = await terminal.start({ cols: 200, rows: 50 })
  const family = shellFamily(started?.shell)
  const id = Math.random().toString(36).slice(2, 12)
  let buffer = ''
  let dispose = () => {}

  try {
    if (family === 'ssh' || family === 'cmd') {
      return ''
    }

    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve(''), 10_000)
      dispose = terminal.onData(started.id, chunk => {
        buffer += String(chunk ?? '')
        const done = extractOutput(buffer, id)

        if (done) {
          clearTimeout(timer)
          resolve(done.exitCode === 0 ? deviceNameFrom(done.output.split('\n').at(-1)) : '')
        }
      })
      Promise.resolve(terminal.attach(started.id))
        .then(() => terminal.write(started.id, wrapCommand(win ? '$env:COMPUTERNAME' : 'hostname', id, family)))
        .catch(() => resolve(''))
    })
  } finally {
    dispose()
    await terminal.dispose(started.id).catch(() => {})
  }
}

// The helper's status if it is running on this machine, else null.
export async function probeHelper(fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(`${HELPER_URL}/status`, { signal: AbortSignal.timeout(800) })

    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// Talking to the helper's settings, with the token only this user's files hold.
export async function readHelperToken(home, win, bridge = globalThis.window?.hermesDesktop) {
  const res = await bridge?.readFileText?.(`${home}${win ? '\\' : '/'}local-token`)

  return typeof res?.text === 'string' ? res.text.trim() : ''
}

export async function helperCall(pathname, token, body, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`${HELPER_URL}${pathname}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-talaria-token': token },
    method: body === undefined ? 'GET' : 'POST'
  })
  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    throw new Error(data.error || `the helper answered ${res.status}`)
  }

  return data
}

// The dashboard Desktop is bound to (Settings > Gateway), as the helper's default address.
export async function gatewayAddress(bridge = globalThis.window?.hermesDesktop) {
  try {
    const config = await bridge?.getConnectionConfig?.()

    if (!config?.remoteUrl || !['remote', 'cloud'].includes(config.mode)) {
      return ''
    }

    return new URL(config.remoteUrl).origin
  } catch {
    return ''
  }
}

function sameFolders(a = [], b = [], win) {
  const norm = list => list.map(f => normalizePath(f, win) || f).map(f => (win ? f.toLowerCase() : f))
  const [x, y] = [norm(a), norm(b)]

  return x.length === y.length && x.every((f, i) => f === y[i])
}

// One list: the app's name and folders are the helper's. The app takes the helper's folders only
// while it has none of its own (a helper set up first, from the command line).
export function helperPlan(current, desired, win) {
  const change = {}
  let adopt = null

  if (!desired.folders.length && current.folders?.length) {
    adopt = current.folders
  } else if (!sameFolders(desired.folders, current.folders, win)) {
    change.folders = desired.folders
  }

  if (desired.name && desired.name !== current.name) {
    change.name = desired.name
  }

  if (desired.server && desired.server !== current.server) {
    change.server = desired.server
  }

  for (const key of ['browser', 'screen', 'browser_app']) {
    const want = desired[key]
    const have = current[key] ?? (key === 'browser_app' ? 'auto' : false)

    if (want !== undefined && want !== have) {
      change[key] = want
    }
  }

  return { adopt, change: Object.keys(change).length ? change : null }
}

// Double quotes read the same in a POSIX shell and in PowerShell.
export function helperCommand(script, action, server = '') {
  const quote = value => `"${String(value).replace(/"/g, '')}"`

  return action === 'install'
    ? `node ${quote(script)} install --remove-source${server ? ` --server ${quote(server)}` : ''}`
    : `node ${quote(script)} uninstall`
}

function folderOf(file) {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
}

// Runs the helper's own install or uninstall in a terminal of this app. Install takes the helper
// from the dashboard (the same checkout as the server half), so the versions match.
async function helperAction(ctx, bridge, win, action, { home, server }) {
  let script

  if (action === 'install') {
    const { source } = await ctx.rest('/helper')
    script = (await bridge.writeTextFile('~/.talaria-helper-setup.mjs', source)).path
  } else {
    script = `${home}${win ? '\\' : '/'}talaria-helper.mjs`
  }

  const folder = folderOf(script)
  const result = await runCommand(bridge, { command: helperCommand(script, action, server), cwd: folder, timeout: 90 },
    [normalizePath(folder, win)], win, new Map(), `helper-${action}`)

  if (result.exit_code !== 0) {
    const missing = /not recognized|not found/i.test(result.output)
    throw new Error(missing
      ? 'Node 18 or later is needed. On Windows: winget install OpenJS.NodeJS.LTS. On a Mac: brew install node. Then restart Hermes Desktop.'
      : result.output.split('\n').slice(-4).join(' ') || `exit code ${result.exit_code}`)
  }

  return result.output.split('\n').filter(Boolean).at(-1) || ''
}

const FIELD = 'w-full rounded border border-(--ui-border) bg-transparent px-2 py-1 text-sm'
const BUTTON = 'rounded border border-(--ui-border) px-3 py-1 text-sm hover:bg-(--ui-bg-hover) disabled:opacity-50'
const HINT = 'text-(--ui-text-tertiary)'

function labelled(title, input, hint) {
  return jsxs('label', {
    className: 'flex flex-col gap-1',
    children: [jsx('span', { className: 'font-medium', children: title }), input, hint ? jsx('span', { className: HINT, children: hint }) : null]
  })
}

// What the agent may do here beyond the folders. Off until switched on; the helper does the work.
function Abilities({ ctx, sync }) {
  const [browser, setBrowser] = useState(() => ctx.storage.get('allowBrowser', false) === true)
  const [app, setApp] = useState(() => ctx.storage.get('browserApp', 'auto'))
  const [screen, setScreen] = useState(() => ctx.storage.get('allowScreen', false) === true)
  const toggle = (key, set) => e => {
    set(e.target.checked)
    ctx.storage.set(key, e.target.checked)
    sync()
  }
  const check = (checked, onChange, title, hint) =>
    jsxs('label', {
      className: 'flex flex-col gap-1',
      children: [
        jsxs('span', { className: 'flex items-center gap-2 font-medium', children: [jsx('input', { checked, onChange, type: 'checkbox' }), title] }),
        jsx('span', { className: HINT, children: hint })
      ]
    })

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      check(browser, toggle('allowBrowser', setBrowser), 'Let Athena use a web browser here',
        'Opens its own browser window with a Talaria-only profile, separate from your everyday one. Sites you sign in to there stay signed in.'),
      browser
        ? labelled('Browser',
          jsx('select', {
            className: FIELD,
            onChange: e => {
              setApp(e.target.value)
              ctx.storage.set('browserApp', e.target.value)
              sync()
            },
            value: app,
            children: [['auto', 'The first one installed'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'],
              ['firefox', 'Firefox'], ['safari', 'Safari (Mac; turn on Develop > Allow Remote Automation)']]
              .map(([value, label]) => jsx('option', { value, children: label }))
          }))
        : null,
      check(screen, toggle('allowScreen', setScreen), 'Let Athena see and control the screen',
        'Screenshots, mouse and keyboard on this machine. On a Mac, allow Screen Recording and Accessibility for the helper when asked.')
    ]
  })
}

function HelperSection({ ctx, server, setServer, sync, win }) {
  const bridge = globalThis.window?.hermesDesktop
  const [helper, setHelper] = useState(null)
  const [gateway, setGateway] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [login, setLogin] = useState({ password: '', username: '' })
  const address = server || gateway

  useEffect(() => {
    let live = true
    const poll = () => probeHelper().then(found => live && setHelper(found))
    gatewayAddress().then(found => live && setGateway(found))
    poll()
    const timer = setInterval(poll, 3000)

    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const act = async (label, work) => {
    setBusy(true)
    setMessage(`${label}…`)

    try {
      setMessage(await work())
      setHelper(await probeHelper())
      sync()
    } catch (error) {
      setMessage(`${label} failed: ${String(error?.message || error)}`)
    } finally {
      setBusy(false)
    }
  }
  const install = () => act(helper ? 'Updating the helper' : 'Installing the helper', async () => {
    const said = await helperAction(ctx, bridge, win, 'install', { server: address })

    for (let i = 0; i < 16; i += 1) {
      if (await probeHelper()) {
        return `${said} If it says it is signed out below, sign it in.`
      }

      await new Promise(resolve => setTimeout(resolve, 500))
    }

    const log = await bridge?.readFileText?.(HELPER_LOG(win)).catch(() => null)
    const tail = String(log?.text || '').trim().split('\n').slice(-4).join(' / ')

    throw new Error(`it installed, but the helper did not stay running.${tail ? ` Its log ends: ${tail}` : ''}`)
  })
  const remove = () => act('Removing the helper', () => helperAction(ctx, bridge, win, 'uninstall', { home: helper.home }))
  const signIn = () => act('Signing in', async () => {
    const token = await readHelperToken(helper.home, win)
    const res = await helperCall('/login', token, login)
    setLogin({ password: '', username: login.username })

    return `Signed in. ${res.status}`
  })
  const signedOut = helper && /signed out|Not connected/i.test(helper.status || '')

  return jsxs('div', {
    className: 'flex flex-col gap-3 rounded border border-(--ui-border) p-3',
    children: [
      jsx('span', { className: 'font-medium', children: 'Background helper' }),
      jsx('span', {
        className: HINT,
        children: helper
          ? `Running as this machine's device (key ${helper.key}, version ${helper.version}). ${helper.status}`
          : 'Not running on this machine. Install it to keep this machine reachable with the app closed. It uses the name and folders above.'
      }),
      labelled('Dashboard address',
        jsx('input', {
          className: FIELD,
          onBlur: () => {
            ctx.storage.set('server', server.trim())
            sync()
          },
          onChange: e => setServer(e.target.value),
          placeholder: gateway || 'http://host:9119',
          value: server
        }),
        gateway
          ? `Empty uses the gateway this app is bound to (${gateway}).`
          : 'This app uses its own local backend, so type the address of the shared dashboard.'),
      jsx(Abilities, { ctx, sync }),
      jsxs('div', {
        className: 'flex gap-2',
        children: [
          jsx('button', { className: BUTTON, disabled: busy || !address, onClick: install, type: 'button', children: helper ? 'Update helper' : 'Install helper' }),
          helper ? jsx('button', { className: BUTTON, disabled: busy, onClick: remove, type: 'button', children: 'Remove helper' }) : null
        ]
      }),
      signedOut
        ? jsxs('div', {
            className: 'flex flex-col gap-2',
            children: [
              jsx('span', { className: HINT, children: 'Sign the helper in with the dashboard login. The password goes to the helper once and is not kept.' }),
              jsx('input', { autoComplete: 'username', className: FIELD, onChange: e => setLogin({ ...login, username: e.target.value }), placeholder: 'Username', value: login.username }),
              jsx('input', { autoComplete: 'current-password', className: FIELD, onChange: e => setLogin({ ...login, password: e.target.value }), placeholder: 'Password', type: 'password', value: login.password }),
              jsx('button', { className: `${BUTTON} self-start`, disabled: busy, onClick: signIn, type: 'button', children: 'Sign in' })
            ]
          })
        : null,
      message ? jsx('span', { className: HINT, children: message }) : null
    ]
  })
}

// The status line, kept current; the approval command in it copies with a click.
function StatusLine({ ctx, status }) {
  const [text, setText] = useState(status)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const timer = setInterval(() => setText(status()), 2000)

    return () => clearInterval(timer)
  }, [])

  const match = /\/talaria approve \S+ \S+/.exec(text)

  if (!match) {
    return jsx('div', { className: HINT, children: text })
  }

  const copy = async () => {
    const ok = await (ctx.os?.writeClipboard?.(match[0]) ??
      globalThis.navigator?.clipboard?.writeText(match[0]).then(() => true))
      .catch(() => false)
    setCopied(Boolean(ok))
    setTimeout(() => setCopied(false), 2000)
  }

  return jsxs('div', {
    className: HINT,
    children: [
      text.slice(0, match.index),
      jsx('button', {
        className: 'rounded border border-(--ui-border) px-1 font-mono hover:bg-(--ui-bg-hover)',
        onClick: copy,
        title: 'Copy',
        type: 'button',
        children: match[0]
      }),
      copied ? ' Copied.' : ' (click to copy)',
      text.slice(match.index + match[0].length)
    ]
  })
}

function Settings({ ctx, status, sync }) {
  const win = isWindowsPlatform()
  const [useHelper, setUseHelper] = useState(() => ctx.storage.get('useHelper', true))
  const [name, setName] = useState(() => ctx.storage.get('name', defaultName(win)))
  const [roots, setRoots] = useState(() => ctx.storage.get('roots', ''))
  const [server, setServer] = useState(() => ctx.storage.get('server', ''))
  const saved = parseRoots(roots, win)

  return jsxs('div', {
    className: 'flex max-w-xl flex-col gap-4 p-4 text-sm',
    children: [
      labelled('Device name',
        jsx('input', {
          className: FIELD,
          onBlur: () => {
            ctx.storage.set('name', name.trim().toLowerCase())
            sync()
          },
          onChange: e => setName(e.target.value),
          value: name
        }),
        'Lowercase letters, digits and dashes. Athena uses this name to aim at this device.'),
      labelled('Allowed folders (one per line)',
        jsx('textarea', {
          className: `${FIELD} min-h-28 font-mono`,
          onBlur: () => {
            ctx.storage.set('roots', roots)
            sync()
          },
          onChange: e => setRoots(e.target.value),
          value: roots
        }),
        `Talaria refuses any path outside these, here and in the background helper. ${saved.length} folder(s) in force. Empty means nothing is allowed.`),
      jsxs('label', {
        className: 'flex items-center gap-2 font-medium',
        children: [
          jsx('input', {
            checked: useHelper,
            onChange: e => {
              setUseHelper(e.target.checked)
              ctx.storage.set('useHelper', e.target.checked)
            },
            type: 'checkbox'
          }),
          'Use the background helper when it runs on this machine'
        ]
      }),
      useHelper ? jsx(HelperSection, { ctx, server, setServer, sync, win }) : null,
      jsx(StatusLine, { ctx, status })
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

    // The helper takes this app's name, folders and dashboard address.
    let helperToken = { home: '', token: '' }
    const syncHelper = async helper => {
      if (helperToken.home !== helper.home || !helperToken.token) {
        helperToken = { home: helper.home, token: await readHelperToken(helper.home, win, bridge) }
      }

      const current = await helperCall('/config', helperToken.token).catch(error => {
        helperToken = { home: '', token: '' } // read the token again next time
        throw error
      })
      const desired = {
        folders: roots().map(r => toNative(r, win)),
        browser: ctx.storage.get('allowBrowser', false) === true,
        browser_app: ctx.storage.get('browserApp', 'auto'),
        name: ctx.storage.get('name', defaultName(win)),
        screen: ctx.storage.get('allowScreen', false) === true,
        server: ctx.storage.get('server', '') || (await gatewayAddress(bridge))
      }
      const plan = helperPlan(current, desired, win)

      if (plan.adopt) {
        ctx.storage.set('roots', plan.adopt.join('\n'))
      }

      if (plan.change) {
        await helperCall('/config', helperToken.token, plan.change)
      }
    }

    const hello = async () => {
      if (disposed || !identity) {
        return
      }

      // With the helper running, it is this machine's device: hand it the chats shown here instead.
      if (ctx.storage.get('useHelper', true)) {
        const helper = await probeHelper()

        if (helper) {
          const claims = [...sessions.entries()].map(([session_id, at]) => ({ at, session_id }))

          await fetch(`${HELPER_URL}/sessions`, {
            body: JSON.stringify({ sessions: claims }),
            headers: { 'content-type': 'application/json' },
            method: 'POST'
          }).catch(() => {})
          lastStatus = `Using the background helper. ${helper.status}`
          await syncHelper(helper).catch(error => {
            lastStatus += ` (Could not pass it these settings: ${String(error?.message || error)})`
          })

          return
        }
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
      render: () => jsx(Settings, { ctx, status: () => lastStatus, sync: () => hello() }),
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
      .then(async loaded => {
        // A device that was never named takes the computer's name.
        if (ctx.storage.get('name', null) === null) {
          const found = await computerName(bridge, win).catch(() => '')

          if (found) {
            ctx.storage.set('name', found)
          }
        }

        identity = loaded
        hello()
      })
      .catch(error => {
        lastStatus = `Could not create this device's key: ${String(error?.message || error)}`
      })
  }
}
