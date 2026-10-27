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
// With an Oikos address set (talaria-helper oikos ws://...), it also, or only, serves Athena on Oikos: the same key and
// the same work over Oikos's own gateway (oikos/1), approved at Oikos's console instead of with /talaria approve.
//
//   talaria-helper setup        first-time setup: server, sign-in, name
//   talaria-helper run          run in the foreground (what the background service runs)
//   talaria-helper install      run it in the background at login, from a copy of this file
//                               [--server <address>] [--remove-source]
//   talaria-helper uninstall    stop that
//   talaria-helper status       is it running, and as which device
//   talaria-helper login        sign in to the dashboard again
//   talaria-helper folders [add <path> | remove <path>]
//   talaria-helper oikos [<address> | off]   also serve Athena on Oikos, e.g. ws://10.0.0.8:11600
//
// Node 22 or later (older versions are out of support, and the browser needs its built-in WebSocket), and nothing else.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.4.0'
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

// ------------------------------------------------------------------ the browser

// A browser on this machine, in a window the user can watch, with a profile of the helper's own
// (never the user's everyday one). Chrome, Edge and Brave are driven over the DevTools protocol,
// Firefox over WebDriver BiDi, and Safari through its own safaridriver, all with Node's built-ins.
// Pages are read back as text with numbered elements, so a model without vision can use it.
const MAX_SNAPSHOT_CHARS = 16_000
const PAGE_SCHEMES = ['http:', 'https:', 'about:']
export const BROWSERS = ['chrome', 'edge', 'brave', 'firefox', 'safari']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function browserCandidates(product, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES || env.ProgramFiles, env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    const app = {
      brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      chrome: 'Google\\Chrome\\Application\\chrome.exe',
      edge: 'Microsoft\\Edge\\Application\\msedge.exe',
      firefox: 'Mozilla Firefox\\firefox.exe'
    }[product]

    return app ? roots.map(root => `${root}\\${app}`) : []
  }

  if (platform === 'darwin') {
    if (product === 'safari') {
      return ['/usr/bin/safaridriver']
    }

    const app = { brave: 'Brave Browser', chrome: 'Google Chrome', edge: 'Microsoft Edge', firefox: 'Firefox' }[product]
    const exe = product === 'firefox' ? 'firefox' : app

    return app ? ['/Applications', path.join(os.homedir(), 'Applications')].map(dir => `${dir}/${app}.app/Contents/MacOS/${exe}`) : []
  }

  const names = {
    brave: ['brave-browser'],
    chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    edge: ['microsoft-edge', 'microsoft-edge-stable'],
    firefox: ['firefox']
  }[product] || []

  return names.flatMap(name => String(env.PATH || '').split(':').filter(Boolean).map(dir => path.join(dir, name)))
}

// The browser to use: the one asked for, else the first one installed.
export function findBrowser(wanted = 'auto', env = process.env) {
  if (env.TALARIA_BROWSER) {
    return { exe: env.TALARIA_BROWSER, product: env.TALARIA_BROWSER_PRODUCT || 'chrome' }
  }

  const order = wanted && wanted !== 'auto' ? [wanted] : BROWSERS

  for (const product of order) {
    const exe = browserCandidates(product, process.platform, env).find(file => fs.existsSync(file))

    if (exe) {
      return { exe, product }
    }
  }

  throw new Error(wanted && wanted !== 'auto'
    ? `${wanted} is not installed on this device`
    : 'no Chrome, Edge, Brave, Firefox or Safari found on this device')
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// One JSON-over-WebSocket connection (Node 22's built-in WebSocket): DevTools and BiDi share it.
class Socket {
  static open(url) {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('this browser needs Node 22 or later on the device')
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const conn = new Socket(socket)
      socket.onopen = () => resolve(conn)
      socket.onerror = () => reject(new Error('could not connect to the browser'))
    })
  }

  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.waiting = new Map()
    this.closed = false
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data))
      const waiter = message.id !== undefined && this.waiting.get(message.id)

      if (waiter) {
        this.waiting.delete(message.id)
        message.error
          ? waiter.reject(new Error(message.error.message || message.message || String(message.error)))
          : waiter.resolve(message.result)
      }
    }
    socket.onclose = () => {
      this.closed = true

      for (const waiter of this.waiting.values()) {
        waiter.reject(new Error('the browser window was closed'))
      }

      this.waiting.clear()
    }
  }

  send(method, params = {}, extra = {}, timeoutMs = 30_000) {
    if (this.closed) {
      return Promise.reject(new Error('the browser window was closed'))
    }

    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...extra }))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`the browser did not answer ${method}`))
      }, timeoutMs)
      this.waiting.set(id, {
        reject: error => (clearTimeout(timer), reject(error)),
        resolve: value => (clearTimeout(timer), resolve(value))
      })
    })
  }

  close() {
    this.closed = true
    this.socket.close()
  }
}

// WebDriver key codes, shared by Firefox (BiDi) and Safari (classic WebDriver).
const WD_KEYS = {
  alt: '', ArrowDown: '', ArrowLeft: '', ArrowRight: '', ArrowUp: '',
  Backspace: '', cmd: '', ctrl: '', Delete: '', End: '', Enter: '',
  Escape: '', Home: '', meta: '', PageDown: '', PageUp: '', shift: '',
  Space: ' ', Tab: ''
}

function wdKeyActions(spec) {
  const parts = String(spec).split('+')
  const keys = parts.map(p => WD_KEYS[p] || WD_KEYS[p.toLowerCase()] || p)

  return [...keys.map(value => ({ type: 'keyDown', value })), ...keys.reverse().map(value => ({ type: 'keyUp', value }))]
}

function wdTypeActions(text) {
  return [...String(text)].flatMap(value => [{ type: 'keyDown', value }, { type: 'keyUp', value }])
}

function wdClickActions(x, y) {
  return [{
    actions: [{ duration: 0, origin: 'viewport', type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
      { button: 0, type: 'pointerDown' }, { button: 0, type: 'pointerUp' }],
    id: 'mouse',
    parameters: { pointerType: 'mouse' },
    type: 'pointer'
  }]
}

const CDP_KEYS = {
  ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, Backspace: 8, Delete: 46, End: 35, Enter: 13,
  Escape: 27, Home: 36, PageDown: 34, PageUp: 33, Space: 32, Tab: 9
}

// Chrome, Edge, Brave: the DevTools protocol.
class ChromiumDriver {
  constructor(exe, profile) {
    this.exe = exe
    this.profile = profile
  }

  async start(headless) {
    fs.mkdirSync(this.profile, { recursive: true })
    const portFile = path.join(this.profile, 'DevToolsActivePort')
    fs.rmSync(portFile, { force: true })
    const args = [`--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--no-first-run',
      '--no-default-browser-check', '--disable-features=Translate', 'about:blank']
    // Chrome will not sandbox itself as root (a container); it never is on a user's own machine.
    const extra = [...(headless ? ['--headless=new'] : []), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]
    this.child = spawn(this.exe, [...extra, ...args], { detached: !WIN, stdio: 'ignore' })
    this.child.unref()

    for (let i = 0; i < 150 && !this.port; i += 1) {
      const text = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : ''
      this.port = text.includes('\n') ? Number(text.split('\n')[0]) : 0
      await sleep(100)
    }

    if (!this.port) {
      throw new Error('the browser did not start')
    }

    await this.follow()
  }

  alive() {
    return Boolean(this.port && this.child?.exitCode === null && this.page && !this.page.closed)
  }

  async follow() {
    const list = async () => (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).filter(t => t.type === 'page')
    let pages = await list()

    if (!pages.length) {
      await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' })
      pages = await list()
    }

    if (this.page && !this.page.closed && pages[0].id === this.targetId) {
      return
    }

    this.page?.close()
    this.page = await Socket.open(pages[0].webSocketDebuggerUrl)
    this.targetId = pages[0].id
    await this.page.send('Page.enable')
    await this.page.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
  }

  async navigate(url) {
    const res = await this.page.send('Page.navigate', { url })

    if (res.errorText) {
      throw new Error(`could not open ${url}: ${res.errorText}`)
    }
  }

  async evaluate(expression) {
    const { exceptionDetails, result } = await this.page.send('Runtime.evaluate', { awaitPromise: true, expression, returnByValue: true })

    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description?.split('\n')[0] || exceptionDetails.text)
    }

    return result.value
  }

  async click(x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.page.send('Input.dispatchMouseEvent', { button: 'left', clickCount: 1, type, x, y })
    }
  }

  typeText(text) {
    return this.page.send('Input.insertText', { text })
  }

  async press(spec) {
    const parts = String(spec).split('+')
    const main = parts.pop()
    const modifiers = parts.reduce((m, p) => m | ({ alt: 1, cmd: 4, control: 2, ctrl: 2, meta: 4, shift: 8 }[p.toLowerCase()] || 0), 0)
    const code = CDP_KEYS[main] ?? (main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0)
    const base = { code: main.length === 1 ? `Key${main.toUpperCase()}` : main, key: main, modifiers, windowsVirtualKeyCode: code }
    const text = main === 'Enter' ? '\r' : main.length === 1 && !(modifiers & 7) ? main : undefined
    await this.page.send('Input.dispatchKeyEvent', { ...base, text, type: text ? 'keyDown' : 'rawKeyDown' })
    await this.page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  async screenshot() {
    const shot = await this.page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })

    return { data: shot.data, media_type: 'image/jpeg' }
  }

  back() {
    return this.evaluate('history.back()')
  }

  async close() {
    this.page?.close()
    const version = await fetch(`http://127.0.0.1:${this.port}/json/version`).then(r => r.json()).catch(() => null)

    if (version?.webSocketDebuggerUrl) {
      const browser = await Socket.open(version.webSocketDebuggerUrl).catch(() => null)
      await browser?.send('Browser.close').catch(() => {})
      browser?.close()
    }

    this.child?.kill()
  }
}

// Firefox: WebDriver BiDi, which Firefox serves itself (no geckodriver).
class FirefoxDriver {
  constructor(exe, profile) {
    this.exe = exe
    this.profile = profile
  }

  async start(headless) {
    fs.mkdirSync(this.profile, { recursive: true })
    fs.writeFileSync(path.join(this.profile, 'user.js'), [
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("browser.download.always_ask_before_handling_new_types", true);',
      'user_pref("remote.active-protocols", 1);', ''
    ].join('\n'))
    const port = await freePort()
    const args = ['--remote-debugging-port', String(port), '--profile', this.profile, '--no-remote', '--new-instance', 'about:blank']
    this.child = spawn(this.exe, headless ? ['--headless', ...args] : args, { detached: !WIN, stdio: 'ignore' })
    this.child.unref()

    for (let i = 0; i < 150 && !this.bidi; i += 1) {
      this.bidi = await Socket.open(`ws://127.0.0.1:${port}/session`).catch(() => null)
      await sleep(this.bidi ? 0 : 200)
    }

    if (!this.bidi) {
      throw new Error('Firefox did not start')
    }

    await this.bidi.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } })
    await this.follow()
  }

  alive() {
    return Boolean(this.bidi && !this.bidi.closed && this.child?.exitCode === null)
  }

  async follow() {
    const { contexts } = await this.bidi.send('browsingContext.getTree', {})
    this.context = contexts.at(-1)?.context || (await this.bidi.send('browsingContext.create', { type: 'tab' })).context
  }

  async navigate(url) {
    await this.bidi.send('browsingContext.navigate', { context: this.context, url, wait: 'complete' }, {}, 30_000)
  }

  async evaluate(expression) {
    const res = await this.bidi.send('script.evaluate', {
      awaitPromise: true,
      expression: `JSON.stringify(${expression})`,
      resultOwnership: 'none',
      target: { context: this.context }
    })

    if (res.type === 'exception') {
      throw new Error(res.exceptionDetails?.text || 'the page script failed')
    }

    return res.result?.value === undefined ? undefined : JSON.parse(res.result.value)
  }

  click(x, y) {
    return this.bidi.send('input.performActions', { actions: wdClickActions(x, y), context: this.context })
  }

  typeText(text) {
    return this.bidi.send('input.performActions', { actions: [{ actions: wdTypeActions(text), id: 'keys', type: 'key' }], context: this.context })
  }

  press(spec) {
    return this.bidi.send('input.performActions', { actions: [{ actions: wdKeyActions(spec), id: 'keys', type: 'key' }], context: this.context })
  }

  async screenshot() {
    const { data } = await this.bidi.send('browsingContext.captureScreenshot', { context: this.context })

    return { data, media_type: 'image/png' }
  }

  back() {
    return this.bidi.send('browsingContext.traverseHistory', { context: this.context, delta: -1 })
  }

  async close() {
    await this.bidi?.send('browser.close', {}).catch(() => {})
    this.bidi?.close()
    this.child?.kill()
  }
}

// Safari: its own WebDriver, in a separate automation window that never sees the user's tabs.
// Needs "Allow Remote Automation" (Safari's Develop menu) once, or `safaridriver --enable`.
class SafariDriver {
  constructor(exe) {
    this.exe = exe
  }

  async request(method, route, body) {
    const res = await fetch(`${this.endpoint}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method,
      signal: AbortSignal.timeout(30_000)
    })
    const data = await res.json().catch(() => ({}))

    if (!res.ok || data.value?.error) {
      const message = data.value?.message || `WebDriver answered ${res.status}`

      throw new Error(/remote automation/i.test(message)
        ? 'Safari needs "Allow Remote Automation" turned on (Safari > Settings > Advanced > Show features for web developers, then Develop > Allow Remote Automation)'
        : `Safari: ${message}`)
    }

    return data.value
  }

  command(method, route, body) {
    return this.request(method, `/session/${this.session}${route}`, body)
  }

  async start() {
    const port = await freePort()
    this.endpoint = `http://127.0.0.1:${port}`
    this.child = spawn(this.exe, ['-p', String(port)], { stdio: 'ignore' })

    for (let i = 0; i < 50; i += 1) {
      if (await fetch(`${this.endpoint}/status`).then(r => r.ok, () => false)) {
        break
      }

      await sleep(100)
    }

    const created = await this.request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })
    this.session = created.sessionId
  }

  alive() {
    return Boolean(this.session && this.child?.exitCode === null)
  }

  async follow() {
    const handles = await this.command('GET', '/window/handles')
    await this.command('POST', '/window', { handle: handles.at(-1) })
  }

  navigate(url) {
    return this.command('POST', '/url', { url })
  }

  async evaluate(expression) {
    const value = await this.command('POST', '/execute/sync', { args: [], script: `return JSON.stringify(${expression})` })

    return value === undefined || value === null ? undefined : JSON.parse(value)
  }

  click(x, y) {
    return this.command('POST', '/actions', { actions: wdClickActions(x, y) })
  }

  typeText(text) {
    return this.command('POST', '/actions', { actions: [{ actions: wdTypeActions(text), id: 'keys', type: 'key' }] })
  }

  press(spec) {
    return this.command('POST', '/actions', { actions: [{ actions: wdKeyActions(spec), id: 'keys', type: 'key' }] })
  }

  async screenshot() {
    return { data: await this.command('GET', '/screenshot'), media_type: 'image/png' }
  }

  back() {
    return this.command('POST', '/back', {})
  }

  async close() {
    await this.command('DELETE', '').catch(() => {})
    this.child?.kill()
  }
}

// Runs in the page: numbers what can be clicked or typed into and writes the page out as text.
const SNAPSHOT_JS = `(() => {
  const out = []
  let n = 0
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const field = el => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
  const label = el => (el.getAttribute('aria-label') || (field(el) ? (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.placeholder || el.title || el.name : el.innerText || el.value || el.title || el.alt) || '').replace(/\\s+/g, ' ').trim().slice(0, 100)
  const role = el => {
    const t = el.tagName.toLowerCase(), type = (el.type || '').toLowerCase()
    if (t === 'a') return 'link'
    if (t === 'select') return 'dropdown'
    if (t === 'textarea' || el.isContentEditable) return 'textbox'
    if (t === 'input') return ['checkbox', 'radio'].includes(type) ? type : ['submit', 'button', 'reset', 'image'].includes(type) ? 'button' : type === 'password' ? 'password' : 'textbox'
    return el.getAttribute('role') || 'button'
  }
  document.querySelectorAll('[data-talaria-ref]').forEach(el => el.removeAttribute('data-talaria-ref'))
  const interactive = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=true],summary'
  const walk = node => {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\\s+/g, ' ').trim()
      if (text) out.push(text)
      return
    }
    if (node.nodeType !== 1) return
    const el = node, tag = el.tagName.toLowerCase()
    if (['script', 'style', 'noscript', 'svg', 'template', 'head'].includes(tag) || !visible(el)) return
    if (el.matches(interactive)) {
      el.setAttribute('data-talaria-ref', String(++n))
      const r = role(el)
      let line = '[' + n + '] ' + r + ' "' + label(el) + '"'
      if (r === 'textbox' && el.value) line += ' value="' + String(el.value).slice(0, 80) + '"'
      if ((r === 'checkbox' || r === 'radio') && el.checked) line += ' checked'
      if (r === 'dropdown') line += ' options: ' + [...el.options].slice(0, 20).map(o => o.text.trim()).join(' | ')
      out.push('\\n' + line + '\\n')
      return
    }
    if (/^h[1-6]$/.test(tag)) out.push('\\n' + '#'.repeat(+tag[1]) + ' ')
    if (['p', 'div', 'li', 'tr', 'br', 'section', 'article', 'header', 'footer', 'nav', 'ul', 'ol', 'table', 'form', 'main', 'aside'].includes(tag)) out.push('\\n')
    if (tag === 'li') out.push('- ')
    for (const child of el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes) walk(child)
    if (tag === 'iframe') out.push('\\n[an embedded frame, not read]\\n')
  }
  walk(document.body || document.documentElement)
  const text = out.join(' ').replace(/ *\\n */g, '\\n').replace(/^(#+) +/gm, '$1 ').replace(/\\n{3,}/g, '\\n\\n').trim()
  return { title: document.title, url: location.href, text, elements: n,
    scrolled: Math.round(scrollY) + ' of ' + Math.max(0, document.documentElement.scrollHeight - innerHeight) + ' px' }
})()`

export function webUrl(value) {
  const raw = String(value || '').trim()
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`only http and https addresses can be opened, not ${url.protocol}`)
  }

  if (url.username || url.password) {
    throw new Error('addresses with a username or password in them are refused')
  }

  return url.href
}

export class Browser {
  constructor(home, env = process.env) {
    this.home = home
    this.env = env
    this.driver = null
    this.product = ''
  }

  async ensure(wanted) {
    const want = wanted && wanted !== 'auto' ? wanted : this.product || 'auto'

    if (this.driver?.alive() && (want === 'auto' || want === this.product)) {
      return this.driver
    }

    await this.driver?.close().catch(() => {})
    const { exe, product } = findBrowser(want, this.env)
    const profile = path.join(this.home, 'browser-profiles', product)
    this.driver = product === 'firefox' ? new FirefoxDriver(exe, profile)
      : product === 'safari' ? new SafariDriver(exe)
        : new ChromiumDriver(exe, profile)
    this.product = product
    await this.driver.start(Boolean(this.env.TALARIA_BROWSER_HEADLESS))

    return this.driver
  }

  async settle(driver, ms = 600) {
    await sleep(ms)
    const deadline = Date.now() + 15_000

    while (Date.now() < deadline && (await driver.evaluate('document.readyState').catch(() => 'loading')) !== 'complete') {
      await sleep(200)
    }
  }

  // Only web pages are read back: a file:// page would get around the folder rules.
  async guard(driver) {
    const href = await driver.evaluate('location.href')
    const scheme = new URL(href).protocol

    if (!PAGE_SCHEMES.includes(scheme)) {
      await driver.navigate('about:blank').catch(() => {})
      throw new Error(`only http and https pages can be used, not ${scheme}`)
    }
  }

  async snapshot(driver) {
    await this.guard(driver)
    const snap = await driver.evaluate(SNAPSHOT_JS)
    const text = snap.text.length > MAX_SNAPSHOT_CHARS
      ? `${snap.text.slice(0, MAX_SNAPSHOT_CHARS)}\n[page text cut short; scroll down for more]`
      : snap.text

    return { browser: this.product, elements: snap.elements, scrolled: snap.scrolled, text, title: snap.title, url: snap.url }
  }

  async center(driver, ref) {
    const box = await driver.evaluate(`(() => {
      const el = document.querySelector('[data-talaria-ref="${Number(ref)}"]')
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, type: (el.type || '').toLowerCase() }
    })()`)

    if (!box) {
      throw new Error(`no element [${ref}] on the page now; take a new snapshot`)
    }

    if (box.type === 'file') {
      throw new Error('file upload fields are not supported')
    }

    return box
  }

  async perform(args, wanted = 'auto') {
    const action = String(args.action || '')

    if (action === 'close') {
      await this.driver?.close().catch(() => {})
      this.driver = null

      return { closed: true }
    }

    const driver = await this.ensure(args.browser || wanted)
    await driver.follow()

    if (action === 'open') {
      await driver.navigate(webUrl(args.url))
      await this.settle(driver)
    } else if (action === 'click') {
      const { x, y } = await this.center(driver, args.ref)
      await driver.click(x, y)
      await this.settle(driver, 800)
      await driver.follow()
    } else if (action === 'type') {
      const { x, y } = await this.center(driver, args.ref)
      await driver.click(x, y)

      if (args.clear !== false) {
        await driver.evaluate(`(() => { const el = document.activeElement
          if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) }
          else if (el && el.isContentEditable) el.textContent = ''
          return true })()`)
      }

      await driver.typeText(String(args.text ?? ''))

      if (args.submit) {
        await driver.press('Enter')
        await this.settle(driver, 800)
        await driver.follow()
      }
    } else if (action === 'select') {
      await driver.evaluate(`(() => {
        const el = document.querySelector('[data-talaria-ref="${Number(args.ref)}"]')
        if (!el || el.tagName !== 'SELECT') throw new Error('[${Number(args.ref)}] is not a dropdown')
        const want = ${JSON.stringify(String(args.text ?? ''))}.trim().toLowerCase()
        const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
        if (!opt) throw new Error('no option ' + JSON.stringify(want))
        el.value = opt.value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
    } else if (action === 'press') {
      await driver.press(args.key || 'Enter')
      await this.settle(driver, 500)
      await driver.follow()
    } else if (action === 'scroll') {
      const dy = args.direction === 'up' ? -1 : 1
      await driver.evaluate(`(scrollBy(0, ${dy} * innerHeight * 0.8), true)`)
      await sleep(300)
    } else if (action === 'back') {
      await driver.back()
      await this.settle(driver)
    } else if (action === 'screenshot') {
      await this.guard(driver)
      const image = await driver.screenshot()
      const { title, url } = await this.snapshot(driver)

      return { browser: this.product, image, title, url }
    } else if (action !== 'snapshot') {
      throw new Error(`unknown browser action ${action}`)
    }

    return this.snapshot(driver)
  }
}

// ------------------------------------------------------------------ the screen

// Screenshots, mouse and keyboard on this machine's own screen, with what the OS already has:
// PowerShell and .NET on Windows, screencapture and JavaScript for Automation on a Mac, xdotool and
// ImageMagick on Linux (X11). Screenshots are scaled down to SCREEN_WIDTH; coordinates the agent
// sends are in that scaled image and are mapped back here.
const SCREEN_WIDTH = 1280

function runFile(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `${file} failed`))))

    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

function powershell(script) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')

  return runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded])
}

const WIN_PRELUDE = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class TalariaInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
}
'@
[void][TalariaInput]::SetProcessDPIAware()
`

// SendKeys spelling for the keys and combinations the agent names.
const SENDKEYS = {
  backspace: '{BACKSPACE}', delete: '{DELETE}', down: '{DOWN}', end: '{END}', enter: '{ENTER}', esc: '{ESC}',
  escape: '{ESC}', home: '{HOME}', left: '{LEFT}', pagedown: '{PGDN}', pageup: '{PGUP}', return: '{ENTER}',
  right: '{RIGHT}', space: ' ', tab: '{TAB}', up: '{UP}'
}

export function sendKeysFor(spec) {
  const parts = String(spec).toLowerCase().split('+').map(p => p.trim()).filter(Boolean)
  const main = parts.pop() || ''
  const mods = parts.map(p => ({ alt: '%', cmd: '^', control: '^', ctrl: '^', option: '%', shift: '+' }[p] ?? '')).join('')
  const key = SENDKEYS[main] || SENDKEYS[main.replace(/^arrow/, '')] || (/^f\d{1,2}$/.test(main) ? `{${main.toUpperCase()}}` : sendKeysText(main))

  return mods + key
}

export function sendKeysText(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`).replace(/\r?\n/g, '{ENTER}')
}

// AppleScript key codes for the named keys (letters and digits go through keystroke).
const MAC_KEYCODES = {
  backspace: 51, delete: 117, down: 125, end: 119, enter: 36, esc: 53, escape: 53, home: 115, left: 123,
  pagedown: 121, pageup: 116, return: 36, right: 124, space: 49, tab: 48, up: 126
}

function appleScriptString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export class Screen {
  constructor(home, platform = process.platform) {
    this.home = home
    this.platform = platform
    this.geometry = null
  }

  // A screenshot of the main screen, scaled; remembers how to map its pixels back to the screen.
  async capture() {
    const file = path.join(os.tmpdir(), `talaria-screen-${process.pid}.jpg`)

    try {
      if (this.platform === 'win32') {
        const out = await powershell(`${WIN_PRELUDE}
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$w = [Math]::Min(${SCREEN_WIDTH}, $b.Width); $h = [int]($b.Height * $w / $b.Width)
$small = New-Object System.Drawing.Bitmap $bmp, $w, $h
$small.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
@{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height; w = $w; h = $h } | ConvertTo-Json -Compress`)
        const g = JSON.parse(out)
        this.geometry = { height: g.height, imageHeight: g.h, imageWidth: g.w, width: g.width, x: g.x, y: g.y }
      } else if (this.platform === 'darwin') {
        await runFile('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', file]).catch(error => {
          throw new Error(`could not take a screenshot (allow Screen Recording for the helper in System Settings > Privacy & Security): ${error.message}`)
        })
        await runFile('/usr/bin/sips', ['-Z', String(SCREEN_WIDTH), file])
        const dims = await runFile('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
        const points = JSON.parse(await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
          "ObjC.import('AppKit'); var f = $.NSScreen.mainScreen.frame; JSON.stringify({ w: f.size.width, h: f.size.height })"]))
        this.geometry = {
          height: points.h,
          imageHeight: Number(/pixelHeight: (\d+)/.exec(dims)[1]),
          imageWidth: Number(/pixelWidth: (\d+)/.exec(dims)[1]),
          width: points.w,
          x: 0,
          y: 0
        }
      } else {
        await runFile('import', ['-window', 'root', '-resize', `${SCREEN_WIDTH}x>`, '-quality', '70', file]).catch(() => {
          throw new Error('screen control on Linux needs ImageMagick (import) and xdotool, on X11')
        })
        const size = await runFile('xdotool', ['getdisplaygeometry'])
        const [width, height] = size.trim().split(/\s+/).map(Number)
        const id = await runFile('identify', ['-format', '%w %h', file])
        const [imageWidth, imageHeight] = id.trim().split(' ').map(Number)
        this.geometry = { height, imageHeight, imageWidth, width, x: 0, y: 0 }
      }

      return { data: fs.readFileSync(file).toString('base64'), media_type: 'image/jpeg' }
    } finally {
      fs.rmSync(file, { force: true })
    }
  }

  // Scaled-image coordinates to the screen's own.
  toScreen(coordinate) {
    const g = this.geometry

    if (!g) {
      throw new Error('take a screenshot first, so coordinates refer to it')
    }

    const [x, y] = (Array.isArray(coordinate) ? coordinate : []).map(Number)

    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > g.imageWidth || y > g.imageHeight) {
      throw new Error(`coordinate must be [x, y] inside the ${g.imageWidth}x${g.imageHeight} screenshot`)
    }

    return [Math.round(g.x + (x * g.width) / g.imageWidth), Math.round(g.y + (y * g.height) / g.imageHeight)]
  }

  async click([x, y], button = 'left', count = 1) {
    if (this.platform === 'win32') {
      const [down, up] = button === 'right' ? [0x08, 0x10] : button === 'middle' ? [0x20, 0x40] : [0x02, 0x04]
      await powershell(`${WIN_PRELUDE}
[void][TalariaInput]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 50
for ($i = 0; $i -lt ${count}; $i++) { [TalariaInput]::mouse_event(${down}, 0, 0, 0, [IntPtr]::Zero); [TalariaInput]::mouse_event(${up}, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60 }`)
    } else if (this.platform === 'darwin') {
      const [downType, upType, cgButton] = button === 'right' ? [3, 4, 1] : button === 'middle' ? [25, 26, 2] : [1, 2, 0]
      await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('CoreGraphics')
var p = $.CGPointMake(${x}, ${y})
$.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, p, 0))
for (var i = 1; i <= ${count}; i++) {
  var d = $.CGEventCreateMouseEvent(null, ${downType}, p, ${cgButton}); $.CGEventSetIntegerValueField(d, 1, i); $.CGEventPost(0, d)
  var u = $.CGEventCreateMouseEvent(null, ${upType}, p, ${cgButton}); $.CGEventSetIntegerValueField(u, 1, i); $.CGEventPost(0, u)
}`]).catch(error => {
        throw new Error(`could not click (allow Accessibility for the helper in System Settings > Privacy & Security): ${error.message}`)
      })
    } else {
      const which = { left: '1', middle: '2', right: '3' }[button] || '1'
      await runFile('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(count), which])
    }
  }

  async scroll([x, y], direction = 'down', amount = 3) {
    const ticks = Math.max(1, Math.min(20, Number(amount) || 3))

    if (this.platform === 'win32') {
      const delta = (direction === 'up' ? 120 : -120) * ticks
      await powershell(`${WIN_PRELUDE}
[void][TalariaInput]::SetCursorPos(${x}, ${y}); [TalariaInput]::mouse_event(0x0800, 0, 0, ${delta}, [IntPtr]::Zero)`)
    } else if (this.platform === 'darwin') {
      await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('CoreGraphics')
$.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(${x}, ${y}), 0))
$.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 1, ${direction === 'up' ? ticks : -ticks}))`])
    } else {
      await runFile('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(ticks), direction === 'up' ? '4' : '5'])
    }
  }

  async type(text) {
    if (this.platform === 'win32') {
      await powershell(`${WIN_PRELUDE}
[System.Windows.Forms.SendKeys]::SendWait('${sendKeysText(text).replace(/'/g, "''")}')`)
    } else if (this.platform === 'darwin') {
      await runFile('/usr/bin/osascript', ['-e', `tell application "System Events" to keystroke ${appleScriptString(text)}`])
    } else {
      await runFile('xdotool', ['type', '--delay', '20', '--', String(text)])
    }
  }

  async key(spec) {
    if (this.platform === 'win32') {
      const parts = String(spec).toLowerCase().split('+')

      if (parts.includes('win') || parts.includes('windows') || parts.includes('super')) {
        // SendKeys has no Windows key: hold it with keybd_event around the rest.
        const rest = parts.filter(p => !['win', 'windows', 'super'].includes(p)).join('+')
        await powershell(`${WIN_PRELUDE}
[TalariaInput]::keybd_event(0x5B, 0, 0, [IntPtr]::Zero)
${rest ? `[System.Windows.Forms.SendKeys]::SendWait('${sendKeysFor(rest).replace(/'/g, "''")}')` : ''}
[TalariaInput]::keybd_event(0x5B, 0, 2, [IntPtr]::Zero)`)
      } else {
        await powershell(`${WIN_PRELUDE}
[System.Windows.Forms.SendKeys]::SendWait('${sendKeysFor(spec).replace(/'/g, "''")}')`)
      }
    } else if (this.platform === 'darwin') {
      const parts = String(spec).toLowerCase().split('+')
      const main = parts.pop()
      const using = parts.map(p => ({ alt: 'option down', cmd: 'command down', command: 'command down', control: 'control down',
        ctrl: 'control down', meta: 'command down', option: 'option down', shift: 'shift down' }[p])).filter(Boolean)
      const code = MAC_KEYCODES[main] ?? MAC_KEYCODES[main.replace(/^arrow/, '')]
      const press = code !== undefined ? `key code ${code}` : `keystroke ${appleScriptString(main)}`
      await runFile('/usr/bin/osascript', ['-e', `tell application "System Events" to ${press}${using.length ? ` using {${using.join(', ')}}` : ''}`])
    } else {
      const map = { cmd: 'super', meta: 'super', option: 'alt', win: 'super', enter: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', tab: 'Tab', space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', delete: 'Delete', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' }
      await runFile('xdotool', ['key', String(spec).toLowerCase().split('+').map(p => map[p] || p).join('+')])
    }
  }

  async perform(args) {
    const action = String(args.action || '')

    if (action === 'click' || action === 'double_click' || action === 'right_click') {
      await this.click(this.toScreen(args.coordinate), action === 'right_click' ? 'right' : args.button || 'left', action === 'double_click' ? 2 : 1)
    } else if (action === 'scroll') {
      await this.scroll(this.toScreen(args.coordinate), args.direction, args.amount)
    } else if (action === 'type') {
      await this.type(String(args.text ?? ''))
    } else if (action === 'key') {
      await this.key(String(args.keys || ''))
    } else if (action === 'wait') {
      await sleep(Math.max(0, Math.min(10, Number(args.seconds) || 1)) * 1000)
    } else if (action !== 'screenshot') {
      throw new Error(`unknown screen action ${action}`)
    }

    if (action !== 'screenshot') {
      await sleep(500)
    }

    const image = await this.capture()
    const g = this.geometry

    return { action, image, size: [g.imageWidth, g.imageHeight] }
  }
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

// ------------------------------------------------------------------ Oikos

const OIKOS_PROTOCOL = 'oikos/1'
const OIKOS_PING_MS = 15_000
const OIKOS_RETRY_MS = [2_000, 5_000, 10_000, 30_000]

// The same key, on Oikos's own gateway (Oikos, design/hands-on-oikos.md): one WebSocket speaking oikos/1. It signs
// in with this machine's key (asking to be enrolled the first time; Kayla approves it at Oikos's console), says what
// it allows (device.offer), and answers device.request with a result signed for exactly that request. The work is
// the same work, checked here against the same folders and switches; nothing trusts Oikos to have checked anything.
export class OikosLink {
  constructor(helper, { log = console.log, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.helper = helper
    this.log = log
    this.WebSocket = WebSocketImpl
    this.status = 'Oikos: not connected yet.'
    this.offered = ''
    this.stopped = false
  }

  sign(kind, nonce, payload) {
    const ts = Date.now()
    const digest = crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
    const message = [OIKOS_PROTOCOL, kind, this.helper.identity.deviceId, String(ts), nonce, digest].join('\n')

    return { signature: crypto.sign(null, Buffer.from(message, 'utf8'), this.helper.identity.key).toString('base64'), ts }
  }

  offer() {
    return {
      abilities: this.helper.abilities(),
      platform: WIN ? 'windows' : process.platform,
      roots: this.helper.roots().map(r => toNative(r)),
      shell: this.helper.shell.name
    }
  }

  // Resolves when the socket closes, with why.
  connect() {
    return new Promise(resolve => {
      const ws = new this.WebSocket(this.helper.config.oikos)
      const send = frame => ws.send(JSON.stringify(frame))
      let next = 0
      let ping = null
      let why = 'closed'
      const asked = new Map()
      const call = (method, params) => new Promise((ok, fail) => {
        const id = ++next
        asked.set(id, { fail, ok })
        send({ id, jsonrpc: '2.0', method, params })
      })
      const sendOffer = async () => {
        const offer = this.offer()
        const text = JSON.stringify(offer)

        if (text !== this.offered) {
          await call('device.offer', offer)
          this.offered = text
        }
      }

      ws.addEventListener('message', async event => {
        let frame

        try {
          frame = JSON.parse(String(event.data))
        } catch {
          return
        }

        if (frame.method === undefined && asked.has(frame.id)) {
          const { fail, ok } = asked.get(frame.id)
          asked.delete(frame.id)
          frame.error ? fail(Object.assign(new Error(frame.error.message), { reason: frame.error.data?.reason })) : ok(frame.result)

          return
        }

        if (frame.method === 'event' && frame.params?.type === 'gateway.hello') {
          const name = String(this.helper.config.name || '').trim().toLowerCase()
          const { signature, ts } = this.sign('sign_in', frame.params.payload.challenge, '')

          try {
            const me = await call('gateway.sign_in', {
              device_id: this.helper.identity.deviceId,
              enroll: { name, public_key: this.helper.identity.publicKey, space: 'private' },
              protocol: OIKOS_PROTOCOL,
              signature,
              ts
            })
            this.offered = ''
            await sendOffer()
            this.online = true
            this.status = `Oikos: online as ${me.device} (${me.person}'s).`
            this.log(this.status)
            ping = setInterval(() => {
              call('gateway.ping', {}).catch(() => {})
              sendOffer().catch(() => {})
            }, OIKOS_PING_MS)
          } catch (error) {
            why = error.reason === 'waiting_for_approval'
              ? `waiting for approval as ${name} (key ${this.helper.identity.deviceId.slice(0, 8)}). At Oikos's console: devices.approve ${name} <person>`
              : error.message
            this.status = `Oikos: ${why}`
          }

          return
        }

        if (frame.method === 'device.request') {
          this.answer(frame, send)
        }
      })
      ws.addEventListener('close', event => {
        clearInterval(ping)

        for (const { fail } of asked.values()) {
          fail(new Error('the connection closed'))
        }

        resolve(event.reason || why)
      })
      ws.addEventListener('error', () => {
        why = `could not reach ${this.helper.config.oikos}`
      })
    })
  }

  async answer(frame, send) {
    const { args = {}, digest, op, request_id: requestId } = frame.params || {}

    try {
      const result = await this.helper.work(op, args)
      const resultText = JSON.stringify(result ?? null)
      const nonce = crypto.randomBytes(12).toString('hex')
      const { signature, ts } = this.sign('result', nonce, `${digest}\n${resultText}`)
      this.log(`Oikos: ${op} done`)
      send({ id: frame.id, jsonrpc: '2.0', result: { digest, nonce, result_text: resultText, signature, ts } })
    } catch (error) {
      this.log(`Oikos: ${op} refused: ${error?.message || error}`)
      send({ error: { code: -32020, data: { reason: 'refused', request_id: requestId }, message: String(error?.message || error) }, id: frame.id, jsonrpc: '2.0' })
    }
  }

  async run() {
    let tries = 0

    while (!this.stopped) {
      this.online = false
      const why = await this.connect()

      if (!this.status.includes('waiting for approval')) {
        this.status = `Oikos: disconnected (${why}).`
      }

      this.log(this.status)
      tries = this.online ? 0 : tries + 1
      await new Promise(resolve => setTimeout(resolve, OIKOS_RETRY_MS[Math.min(tries, OIKOS_RETRY_MS.length - 1)]))
    }
  }
}

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
      kind: 'helper',
      platform: WIN ? 'windows' : process.platform,
      roots: this.roots().map(r => toNative(r)),
      sessions: [...this.sessions.entries()].map(([session_id, at]) => ({ at, session_id })),
      abilities: this.abilities(),
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

  // What this device lets the agent do beyond its folders, as switched on in its settings.
  abilities() {
    const config = this.config

    return ['files', ...(config.browser ? ['browser'] : []), ...(config.screen ? ['screen'] : [])]
  }

  async useBrowser(args) {
    if (!this.config.browser) {
      throw new Error('the browser is switched off on this device (Talaria settings in Hermes Desktop)')
    }

    this.browser ||= new Browser(this.home)

    return this.browser.perform(args, this.config.browser_app || 'auto')
  }

  async useScreen(args) {
    if (!this.config.screen) {
      throw new Error('screen control is switched off on this device (Talaria settings in Hermes Desktop)')
    }

    this.screen ||= new Screen(this.home)

    return this.screen.perform(args)
  }

  // One operation, checked here against this device's own folders and switches, whoever asked.
  async work(op, args) {
    return op === 'browser' ? await this.useBrowser(args)
      : op === 'screen' ? await this.useScreen(args)
        : await perform(op, args, this.roots(), { shell: this.shell })
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
        const result = await this.work(request.op, request.args || {})
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
          status: !this.oikos ? this.status : this.config.server ? `${this.status} ${this.oikos.status}` : this.oikos.status,
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
        const { browser = false, browser_app = 'auto', folders = [], name = '', screen = false, server = '' } = this.config
        send(200, { browser, browser_app, folders, name, screen, server })

        return
      }

      if (req.method === 'POST' && req.url === '/config') {
        readBody(async change => {
          const next = applySettings(this.config, change)
          writeConfig(this.home, next)
          this.log('settings changed from Hermes Desktop')

          return { browser: next.browser === true, folders: next.folders || [], name: next.name, screen: next.screen === true, server: next.server, status: await this.hello() }
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
    this.log(`Starting Talaria helper ${VERSION} (process ${process.pid}).`)
    this.serveLocal()

    if (this.config.oikos) {
      this.oikos = new OikosLink(this, { log: this.log })
      this.oikos.run()

      if (!this.config.server) {
        return new Promise(() => {})
      }
    }

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

  if (change.browser_app !== undefined) {
    if (!['auto', ...BROWSERS].includes(change.browser_app)) {
      throw new Error(`the browser must be one of: auto, ${BROWSERS.join(', ')}`)
    }

    next.browser_app = change.browser_app
  }

  for (const key of ['browser', 'screen']) {
    if (change[key] !== undefined) {
      next[key] = change[key] === true
    }
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
  const folders = config.folders || []

  console.log(
    'Allowed folders come from Talaria\'s settings in Hermes Desktop on this machine, once the helper runs.\n' +
      'Without Desktop here, add them with: talaria-helper folders add <path>'
  )
  writeConfig(helper.home, { ...config, folders, name, server })
  await signIn(helper, server)
  console.log(await helper.hello())
  console.log('Next: talaria-helper install, to keep it running in the background.')
}

function scriptPath() {
  return fileURLToPath(import.meta.url)
}

// --server <address> sets the dashboard first; --remove-source deletes the file this ran from
// (Hermes Desktop's Install button writes a temporary copy).
export function installOptions(args) {
  const options = { removeSource: false, server: '' }

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--server') {
      options.server = String(args[++i] || '')
    } else if (args[i] === '--remove-source') {
      options.removeSource = true
    } else {
      throw new Error(`unknown install option ${args[i]}`)
    }
  }

  return options
}

function install(helper, options = installOptions([])) {
  const target = path.join(helper.home, 'talaria-helper.mjs')
  fs.mkdirSync(helper.home, { recursive: true })

  if (options.server) {
    writeConfig(helper.home, applySettings(helper.config, { server: options.server }))
  }

  if (path.resolve(scriptPath()) !== path.resolve(target)) {
    fs.copyFileSync(scriptPath(), target)

    if (options.removeSource) {
      fs.rmSync(scriptPath(), { force: true })
    }
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
    const service = `${domain}/${SERVICE_LABEL}`
    const loaded = () => spawnSync('launchctl', ['print', service], { stdio: 'ignore' }).status === 0
    const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    // bootout returns before the old helper has fully stopped, and bootstrapping while it still
    // is fails with "Bootstrap failed: 5: Input/output error", so wait for it and retry.
    spawnSync('launchctl', ['bootout', service])

    for (let i = 0; i < 20 && loaded(); i += 1) {
      pause(250)
    }

    let res

    for (let i = 0; i < 4; i += 1) {
      res = spawnSync('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' })

      if (res.status === 0) {
        break
      }

      pause(1000)
    }

    if (res.status !== 0) {
      // Still loaded after all: restart it in place so it runs the new copy.
      if (!loaded() || spawnSync('launchctl', ['kickstart', '-k', service]).status !== 0) {
        throw new Error(`launchctl: ${res.stderr.trim()}`)
      }
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
    startWindowsHelper(node, target)
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

// Started through WMI rather than as a child: a terminal (Hermes Desktop's included) puts what it
// runs in a job that Windows ends together with the terminal's command, background children and all,
// so a plain detached child dies as soon as the install finishes. WMI starts it outside that job.
function startWindowsHelper(node, target) {
  const quote = text => text.replace(/'/g, "''")
  const line = `"${node}" "${target}" run`
  const script =
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; " +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${quote(line)}'; ` +
    `CurrentDirectory = '${quote(path.dirname(target))}'; ProcessStartupInformation = $si }; exit $r.ReturnValue`
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })

  if (res.status !== 0) {
    // WMI refused (it can be locked down); a detached child still runs when started from a plain console.
    spawn(node, [target, 'run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
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

// Oikos's gateway, beside the dashboard or instead of it. The background service picks it up when restarted.
function oikos(helper, address) {
  const config = helper.config

  if (address === 'off') {
    const { oikos: _, ...rest } = config
    writeConfig(helper.home, rest)
    console.log('Oikos: off. Restart the helper (talaria-helper install) for it to take effect.')

    return
  }

  if (address) {
    if (!/^wss?:\/\/[^\s/]+(\/\S*)?$/.test(address)) {
      throw new Error(`not a WebSocket address: ${address} (e.g. ws://10.0.0.8:11600)`)
    }

    writeConfig(helper.home, { ...config, oikos: address })
    console.log(`Oikos: ${address}. Restart the helper (talaria-helper install) for it to take effect; then approve ` +
      `it at Oikos's console: devices.approve ${config.name || '<name>'} <person>`)

    return
  }

  console.log(`Oikos: ${config.oikos || 'off'}`)
}

async function main(argv) {
  const [command = 'help', ...rest] = argv
  const home = helperHome()

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(fs.readFileSync(scriptPath(), 'utf8').split('\n').slice(16, 25).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))

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
      return install(helper, installOptions(rest))
    case 'status':
      return status(helper)
    case 'folders':
      return folders(helper, rest[0], rest[1])
    case 'oikos':
      return oikos(helper, rest[0])
    default:
      throw new Error(`unknown command ${command}; try: talaria-helper help`)
  }
}

// The background service's output goes nowhere on Windows, so `run` also keeps helper.log in the
// helper's settings folder (Hermes Desktop shows its end when the helper will not stay up).
function logToFile(home) {
  const file = path.join(home, 'helper.log')

  try {
    fs.mkdirSync(home, { recursive: true })

    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) {
      fs.renameSync(file, `${file}.old`)
    }
  } catch {
    return
  }

  for (const name of ['log', 'error']) {
    const original = console[name].bind(console)
    console[name] = (...args) => {
      original(...args)
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${args.join(' ')}\n`)
      } catch {
        // a full or locked disk must not stop the helper
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath())) {
  if (process.argv[2] === 'run') {
    logToFile(helperHome())
    process.on('uncaughtException', error => {
      console.error(`Stopped: ${error.stack || error.message}`)
      process.exit(1)
    })
  }

  main(process.argv.slice(2)).catch(error => {
    console.error(`Stopped: ${error.message}`)
    process.exit(1)
  })
}
