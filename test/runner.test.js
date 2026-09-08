import { describe, expect, it } from 'vitest'
import { Runner } from '../src/runner.js'

const node = (script, timeoutMs = 10_000) =>
  new Runner(process.cwd(), timeoutMs).run(process.execPath, ['-e', script])

describe('Runner', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await node('process.stdout.write("hello")')
    expect(r.stdout).toBe('hello')
    expect(r.exitCode).toBe(0)
    expect(r.ok()).toBe(true)
  })

  it('captures stderr separately from stdout', async () => {
    const r = await node('process.stdout.write("out"); process.stderr.write("err")')
    expect(r.stdout).toBe('out')
    expect(r.stderr).toBe('err')
  })

  it('reports a non-zero exit code without throwing', async () => {
    const r = await node('process.exit(3)')
    expect(r.exitCode).toBe(3)
    expect(r.ok()).toBe(false)
  })

  it('records how long the command took', async () => {
    const r = await node('setTimeout(() => {}, 50)')
    expect(r.durationMs).toBeGreaterThanOrEqual(40)
  })

  it('times out a hanging command and marks it', async () => {
    const r = await node('setInterval(() => {}, 1000)', 300)
    expect(r.timedOut).toBe(true)
    expect(r.ok()).toBe(false)
  })

  it('kills the whole process group so grandchildren do not survive', async () => {
    // The child spawns a grandchild that would outlive a naive kill, then
    // writes the grandchild's pid so the test can check it is gone.
    const script = `
      const { spawn } = require('node:child_process')
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      process.stdout.write(String(g.pid))
      setInterval(() => {}, 1000)
    `
    const r = await node(script, 500)
    expect(r.timedOut).toBe(true)
    const grandchild = Number(r.stdout.trim())
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  it('caps captured output and marks the truncation', async () => {
    const r = await node('process.stdout.write("x".repeat(5 * 1024 * 1024))')
    expect(r.stdout.length).toBeLessThan(5 * 1024 * 1024)
    expect(r.stdout).toContain('[output truncated at 4MB]')
  })

  it('returns the last n lines of stderr from tail()', async () => {
    const r = await node('for (const i of [1,2,3,4,5]) console.error("line " + i)')
    expect(r.tail(2)).toBe('line 4\nline 5')
  })

  it('falls back to stdout in tail() when stderr is empty', async () => {
    const r = await node('console.log("only stdout")')
    expect(r.tail(5)).toBe('only stdout')
  })

  it('writes the command line and its output to the log when given one', async () => {
    const lines = []
    const log = { write: (s) => lines.push(s) }
    await new Runner(process.cwd(), 10_000, log).run(process.execPath, ['-e', 'console.log("hi")'])
    const text = lines.join('')
    expect(text).toContain('exit=0')
    expect(text).toContain('hi')
  })

  it('throws when the command cannot be started at all', async () => {
    await expect(new Runner(process.cwd(), 1000).run('definitely-not-a-command-xyz', [])).rejects.toThrow()
  })

  it('escalates to SIGKILL when a child ignores SIGTERM', async () => {
    // A child that swallows SIGTERM must not survive a timeout. Without the
    // escalation it would run forever, and the harness would never notice.
    const script = `
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `
    const started = Date.now()
    const r = await new Runner(process.cwd(), 300, null, { killGraceMs: 400 }).run(process.execPath, ['-e', script])
    expect(r.timedOut).toBe(true)
    expect(r.ok()).toBe(false)
    // Timed out at 300ms, escalated at +400ms; well under the 10s production grace.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('kills the whole group when a child that ignores SIGTERM has a grandchild', async () => {
    const script = `
      const { spawn } = require('node:child_process')
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      process.stdout.write(String(g.pid))
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `
    const r = await new Runner(process.cwd(), 300, null, { killGraceMs: 400 }).run(process.execPath, ['-e', script])
    expect(r.timedOut).toBe(true)
    const grandchild = Number(r.stdout.trim())
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  it('aborts a run through opts.signal and takes the group with it', async () => {
    const controller = new AbortController()
    const script = `
      const { spawn } = require('node:child_process')
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      process.stdout.write(String(g.pid))
      setInterval(() => {}, 1000)
    `
    const promise = new Runner(process.cwd(), 30_000, null).run(process.execPath, ['-e', script], {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const r = await promise
    expect(r.ok()).toBe(false)
    const grandchild = Number(r.stdout.trim())
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  it('escalates to SIGKILL when an aborted child ignores SIGTERM', async () => {
    // The abort path is the FAST path; it must not rely on the unrelated
    // timeout timer as its backstop. Measured at 12.9s before this fix.
    const controller = new AbortController()
    const script = `
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `
    const started = Date.now()
    const promise = new Runner(process.cwd(), 60_000, null, { killGraceMs: 400 }).run(
      process.execPath,
      ['-e', script],
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 200)
    const r = await promise
    expect(r.ok()).toBe(false)
    // 60s timeout, so anything near it means the abort fell through to the timeout.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports a signal-killed child as failed, never as success', async () => {
    // Node gives exitCode null for a signal death; ok() must not read that as 0.
    const r = await new Runner(process.cwd(), 300, null, { killGraceMs: 400 }).run(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ])
    expect(r.exitCode).not.toBe(0)
    expect(r.exitCode).not.toBeNull()
    expect(r.ok()).toBe(false)
  })
})
