// Run: node --import ./talaria/tests/js/register.mjs --test talaria/tests/js/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import plugin, {
  allowedPath, deviceNameFrom, extractOutput, isWithin, normalizePath, parseRoots, perform, shellFamily, wrapCommand
} from '../../desktop/plugin.js'

test('paths normalise and stay inside the allowed folders', () => {
  assert.equal(normalizePath('/home/k/./a//b/../c', false), '/home/k/a/c')
  assert.equal(normalizePath('/../etc', false), null)
  assert.equal(normalizePath('~/x', false), null)
  assert.equal(normalizePath('relative/x', false), null)
  assert.equal(normalizePath('c:\\Users\\Kayla\\..\\Kayla\\Docs', true), 'C:/Users/Kayla/Docs')
  assert.equal(normalizePath('\\\\server\\share', true), null)
  const roots = parseRoots('/home/k/projects\n\n/tmp/x/', false)
  assert.deepEqual(roots, ['/home/k/projects', '/tmp/x'])
  assert.ok(isWithin('/home/k/projects/a', roots, false))
  assert.ok(!isWithin('/home/k/projects-evil/a', roots, false))
  assert.ok(isWithin('c:/users/kayla/docs/a', parseRoots('C:\\Users\\Kayla\\Docs', true), true))
  assert.throws(() => allowedPath('/home/k/projects/../secret', roots, false), /outside/)
  assert.throws(() => allowedPath('/home/k/projects/a', [], false), /no allowed folders/)
})

test('shell families', () => {
  assert.equal(shellFamily('zsh'), 'posix')
  assert.equal(shellFamily('pwsh.exe'), 'powershell')
  assert.equal(shellFamily('ssh'), 'ssh')
  assert.equal(shellFamily('cmd.exe'), 'cmd')
  assert.equal(shellFamily('fish'), 'fish')
})

// A fake of window.hermesDesktop.terminal: echoes what is typed (as a real pty does), then runs the
// line in a real shell and streams its output back.
function fakeTerminal(shell = 'bash', cwd = '/tmp') {
  const listeners = new Map()
  const calls = []
  return {
    calls,
    terminal: {
      start: async opts => { calls.push(['start', opts]); return { cwd, id: 't1', shell } },
      attach: async () => true,
      dispose: async id => { calls.push(['dispose', id]); return true },
      onData: (id, cb) => { listeners.set(id, cb); return () => listeners.delete(id) },
      write: async (id, data) => {
        calls.push(['write', data])
        const emit = listeners.get(id)
        if (data === '\x03') return true
        emit?.(`\x1b[1m$\x1b[0m ${data}\n`)
        const child = spawn(shell, ['-c', data.replace(/\r$/, '')], { cwd })
        child.stdout.on('data', chunk => emit?.(chunk.toString().replace(/\n/g, '\r\n')))
        child.stderr.on('data', chunk => emit?.(chunk.toString()))
        return true
      }
    }
  }
}

test('run: markers survive the echo, output and exit code come back', async () => {
  const fake = fakeTerminal()
  const result = await perform(fake, 'run', { command: "echo 'héllo'; printf 'two\\n'; exit_code() { return 3; }; exit_code", cwd: '/tmp', timeout: 10 },
    ['/tmp'], false, new Map(), 'r1')
  assert.equal(result.output, 'héllo\ntwo')
  assert.equal(result.exit_code, 3)
  assert.equal(result.timed_out, false)
  assert.equal(fake.calls.at(-1)[0], 'dispose')
})

test('run: refuses over SSH, a missing folder, and paths outside the rules', async () => {
  await assert.rejects(perform(fakeTerminal('ssh'), 'run', { command: 'ls', cwd: '/tmp', timeout: 5 }, ['/tmp'], false, new Map(), 'r'), /SSH/)
  await assert.rejects(perform(fakeTerminal('bash', '/root'), 'run', { command: 'ls', cwd: '/tmp/nope', timeout: 5 }, ['/tmp'], false, new Map(), 'r'), /does not exist/)
  await assert.rejects(perform(fakeTerminal(), 'run', { command: 'ls', cwd: '/etc', timeout: 5 }, ['/tmp'], false, new Map(), 'r'), /outside/)
})

test('run: a timeout interrupts and reports', async () => {
  const fake = fakeTerminal()
  const result = await perform(fake, 'run', { command: 'sleep 5', cwd: '/tmp', timeout: 1 }, ['/tmp'], false, new Map(), 'r')
  assert.equal(result.timed_out, true)
  assert.ok(fake.calls.some(c => c[0] === 'write' && c[1] === '\x03'))
})

test('read and list check the resolved path too', async () => {
  const bridge = {
    readFileText: async p => ({ binary: false, byteSize: 2, path: p === '/tmp/link' ? '/etc/passwd' : p, text: 'hi', truncated: false }),
    readDir: async p => ({ entries: [{ isDirectory: true, name: 'a', path: `${p}/a` }] })
  }
  assert.equal((await perform(bridge, 'read', { path: '/tmp/a.txt' }, ['/tmp'], false)).text, 'hi')
  await assert.rejects(perform(bridge, 'read', { path: '/tmp/link' }, ['/tmp'], false), /resolves outside/)
  assert.deepEqual((await perform(bridge, 'list', { path: '/tmp' }, ['/tmp'], false)).entries, [{ name: 'a', type: 'dir' }])
})

test('extractOutput ignores the echoed command line', () => {
  const line = wrapCommand('ls', 'abc', 'posix')
  assert.ok(!line.includes('__TALARIA_BEGIN_abc'))
  assert.equal(extractOutput(`${line}\r\n`, 'abc'), null)
  assert.deepEqual(extractOutput(`${line}\r\n__TALARIA_BEGIN_abc\r\nx\r\n\r\n__TALARIA_END_abc:0\r\n`, 'abc'), { exitCode: 0, output: 'x' })
})

test('the default export is a plugin the loader accepts', () => {
  assert.equal(plugin.id, 'talaria')
  assert.equal(plugin.defaultEnabled, false)
  assert.equal(typeof plugin.register, 'function')
})

test('the settings page renders, with the helper section', () => {
  const store = new Map([['useHelper', true]])
  const ctx = {
    onDispose: () => {}, onEvent: () => {}, registerSettingsPage: page => { ctx.page = page },
    rest: async () => ({}), setInterval: () => {},
    storage: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) }
  }
  globalThis.window = { hermesDesktop: {} }
  plugin.register(ctx)
  const texts = []
  const walk = node => {
    if (node == null || typeof node !== 'object') {
      if (typeof node === 'string') texts.push(node)
      return
    }
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node.t === 'function') return walk(node.t(node.p))
    walk(node.p?.children)
  }
  walk(ctx.page.render())
  for (const text of ['Device name', 'Allowed folders (one per line)', 'Background helper', 'Dashboard address', 'Install helper']) {
    assert.ok(texts.includes(text), text)
  }
  delete globalThis.window
})

test('the computer\'s name becomes the default device name', () => {
  assert.equal(deviceNameFrom('ANUBIS\r'), 'anubis')
  assert.equal(deviceNameFrom('Kaylas-MacBook-Pro.local'), 'kaylas-macbook-pro')
  assert.equal(deviceNameFrom('DESKTOP_7Q2 X'), 'desktop-7q2-x')
  assert.equal(deviceNameFrom(''), '')
})
