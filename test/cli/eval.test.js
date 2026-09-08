import { spawn } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STATE_HOME_ENV, stateDir } from '../../src/state/index.js'
import { claimEval, evalRunning } from '../../src/state/lock.js'
import { requestStop } from '../../src/state/stop.js'
import { loadRows } from '../../src/results.js'
import { runCli } from '../helpers/cli.js'
import { FAST_WORDCOUNT, WORDCOUNT_TEST, makeBenchRepo } from '../helpers/bench-repo.js'
import { commitFiles, writeFiles } from '../helpers/repo.js'

const original = process.env[STATE_HOME_ENV]
beforeEach(async () => {
  process.env[STATE_HOME_ENV] = await mkdtemp(join(tmpdir(), 'a3s-eval-home-'))
})
afterEach(() => {
  if (original === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = original
})

/** A repo with init + baseline done and a fast count configured. */
async function ready() {
  const dir = await makeBenchRepo()
  await runCli(['init', '-C', dir])
  await writeFiles(dir, { '.autor3search/config.yaml': 'benchmarks: ["countWords"]\ncount: 4\nscope: ["src/**"]\nheap_hint: false\n' })
  await commitFiles(dir, {}, 'init')
  await runCli(['baseline', '-C', dir, '-tag', 't'])
  return dir
}

describe('eval', () => {
  it('appends exactly one results.tsv row per invocation', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    await runCli(['eval', '-C', dir, '-desc', 'faster count'])
    const rows = await loadRows(join(dir, 'results.tsv'))
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('faster count')
    expect(['keep', 'discard']).toContain(rows[0].status)
  })

  it('exits 2 with reason scope_violation for an out-of-scope edit', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'elsewhere/x.js': 'export const x = 1\n' })
    const { code, out } = await runCli(['eval', '-C', dir, '--json', '-desc', 'oops'])
    expect(code).toBe(2)
    expect(JSON.parse(out).reason).toBe('scope_violation')
  })

  it('prints one JSON object and nothing else with --json', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { out } = await runCli(['eval', '-C', dir, '--json', '-desc', 'x'])
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out.trim().startsWith('{')).toBe(true)
    expect(out.trim().endsWith('}')).toBe(true)
  })

  it('includes the run context in the JSON', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const payload = JSON.parse((await runCli(['eval', '-C', dir, '--json', '-desc', 'x'])).out)
    expect(payload.run).toMatchObject({ tag: 't', branch: 'autor3search-javascript/t', experiment: 1 })
    expect(payload.run.worktree).toContain('baseline-worktree')
    expect(payload.stop_requested).toBe(false)
  })

  it('reports a pending stop request alongside a still-valid verdict', async () => {
    const dir = await ready()
    await requestStop(await stateDir(dir, 't'))
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const payload = JSON.parse((await runCli(['eval', '-C', dir, '--json', '-desc', 'x'])).out)
    expect(payload.stop_requested).toBe(true)
    expect(['KEEP', 'DISCARD']).toContain(payload.status)
  })

  it('writes the transcript to run.log rather than stdout', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    await runCli(['eval', '-C', dir, '--json', '-desc', 'x'])
    const log = await readFile(join(dir, 'run.log'), 'utf8')
    expect(log.length).toBeGreaterThan(0)
    expect(log).toMatch(/\$ /)
  })

  it('refuses a second concurrent eval', async () => {
    const dir = await ready()
    const claim = await claimEval(await stateDir(dir, 't'))
    const { code, err } = await runCli(['eval', '-C', dir, '-desc', 'x'])
    expect(code).toBe(2)
    expect(err).toMatch(/already running/)
    await claim.release()
  })

  it('releases the claim when it finishes', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    await runCli(['eval', '-C', dir, '-desc', 'x'])
    const { evalRunning } = await import('../../src/state/lock.js')
    expect((await evalRunning(await stateDir(dir, 't'))).running).toBe(false)
  })

  it('prints warnings above the verdict in human output', async () => {
    const dir = await ready()
    await writeFiles(dir, { '.autor3search/config.yaml': 'benchmarks: ["countWords"]\ncount: 4\nscope: ["src/**"]\nheap_hint: false\n' })
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { out } = await runCli(['eval', '-C', dir, '-desc', 'x'])
    // count: 4 is below the 6 needed for a bounded interval, so the sample-size
    // warning must appear — and above the verdict line.
    expect(out).toMatch(/WARNING:/)
    expect(out.indexOf('WARNING:')).toBeLessThan(out.indexOf('VERDICT:'))
  })

  it('names the verdict and the score in human output', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { out } = await runCli(['eval', '-C', dir, '-desc', 'x'])
    expect(out).toMatch(/VERDICT: (KEEP|DISCARD)/)
    expect(out).toMatch(/score/)
  })

  it('still writes a row when a gate fails before measurement', async () => {
    // A FAIL is an experiment that happened and should be visible in the
    // morning; only an ABORTED experiment leaves no row.
    const dir = await ready()
    await commitFiles(dir, { 'elsewhere/x.js': 'export const x = 1\n' })
    await runCli(['eval', '-C', dir, '-desc', 'oops'])
    expect(await loadRows(join(dir, 'results.tsv'))).toHaveLength(1)
  })

  it('streams the transcript to stdout with --no-log', async () => {
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { out } = await runCli(['eval', '-C', dir, '--no-log', '-desc', 'x'])
    expect(out).toMatch(/\$ /)
    await expect(stat(join(dir, 'run.log'))).rejects.toThrow()
  })

  it('reports ABORTED on SIGINT: no results row, claim released, stop state honest', async () => {
    // The whole abort contract in one test. Nothing was measured, so nothing
    // may be recorded — and a stranded claim would block every later eval.
    // This spawns the REAL binary (rather than runCli's in-process dispatch)
    // because a real OS signal has to land on a real process.
    const dir = await ready()
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })
    const bin = fileURLToPath(new URL('../../bin/autor3search-javascript.js', import.meta.url))

    // `env: process.env` is what carries AUTOR3SEARCH_JAVASCRIPT_STATE_HOME
    // (set by this file's beforeEach) into the child — without it the child
    // would fall back to the developer's real cache directory instead of the
    // test's isolated one.
    const child = spawn(process.execPath, [bin, 'eval', '-C', dir, '--json', '-desc', 'aborted run'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    let closed = false
    child.on('close', () => {
      closed = true
    })

    // Wait until the claim is genuinely held — the signal that the run has
    // actually started — rather than a fixed sleep, which would be flaky one
    // way or the other depending on machine speed.
    const state = await stateDir(dir, 't')
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && !closed) {
      if ((await evalRunning(state)).running) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // Sanity check on the wait itself: if the child had already finished
    // before we got to send the signal, everything below would still pass
    // but for the wrong reason (a completed run, not an aborted one).
    expect(closed).toBe(false)
    child.kill('SIGINT')

    const code = await new Promise((resolve) => child.on('close', resolve))
    expect(code).toBe(2)
    const payload = JSON.parse(out)
    expect(payload.status).toBe('ABORTED')
    expect(payload.reason).toBe('stop_forced')
    // No stop was ever requested for this run, so an interrupt alone must
    // not be reported as if one had been.
    expect(payload.stop_requested).toBe(false)
    expect(await loadRows(join(dir, 'results.tsv'))).toHaveLength(0)
    expect((await evalRunning(state)).running).toBe(false)
  })

  it('reports ABORTED, not FAIL, when SIGINT lands during the test gate rather than measurement', async () => {
    // The gate phase used to ignore the abort signal entirely: Ctrl+C during
    // `tsc`/`eslint`/`vitest` would not be seen until measure() started, and
    // a subprocess killed mid-gate would look like a genuinely failing test
    // (FAIL, with a results.tsv row) rather than an aborted experiment. This
    // proves both: the interrupt is now honoured promptly, and it still
    // produces ABORTED with no row when it hits the slowest gate — the test
    // gate — instead of the measurement phase the other SIGINT test covers.
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    // A frozen test that sleeps well past both this test's patience and the
    // point where the other SIGINT test's interrupt already lands (during
    // measurement) guarantees THIS interrupt instead lands while the test
    // gate's vitest subprocess is still running. testTimeout is raised so
    // vitest's own per-test timeout never fires first and masks the point
    // being tested.
    await writeFiles(dir, {
      'src/wordcount.test.js': `${WORDCOUNT_TEST}\ntest('slow gate', async () => {\n  await new Promise((r) => setTimeout(r, 8000))\n})\n`,
      'vitest.config.js': 'export default { test: { testTimeout: 30000 } }\n',
      '.autor3search/config.yaml': 'benchmarks: ["countWords"]\ncount: 4\nscope: ["src/**"]\nheap_hint: false\n',
    })
    await commitFiles(dir, {}, 'init')
    await runCli(['baseline', '-C', dir, '-tag', 't'])
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT })

    const bin = fileURLToPath(new URL('../../bin/autor3search-javascript.js', import.meta.url))
    const start = Date.now()
    const child = spawn(process.execPath, [bin, 'eval', '-C', dir, '--json', '-desc', 'aborted during gates'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    let closed = false
    child.on('close', () => {
      closed = true
    })

    // Wait until the claim is held (the run has started), same as the other
    // SIGINT test, then give the fast typecheck/lint gates a moment to clear
    // so the interrupt below is guaranteed to land on the slow test gate.
    const state = await stateDir(dir, 't')
    const claimDeadline = Date.now() + 60_000
    while (Date.now() < claimDeadline && !closed) {
      if ((await evalRunning(state)).running) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(closed).toBe(false)
    await new Promise((r) => setTimeout(r, 1500))
    expect(closed).toBe(false) // still inside the 8s test gate, not finished on its own

    child.kill('SIGINT')
    const code = await new Promise((resolve) => child.on('close', resolve))
    const elapsed = Date.now() - start

    // The old behaviour would wait out the rest of the 8s sleep (plus lint
    // and typecheck) before doing anything; the fix kills the gate's
    // subprocess group immediately on abort.
    expect(elapsed).toBeLessThan(6000)
    expect(code).toBe(2)
    const payload = JSON.parse(out)
    expect(payload.status).toBe('ABORTED')
    expect(payload.reason).toBe('stop_forced')
    expect(await loadRows(join(dir, 'results.tsv'))).toHaveLength(0)
    expect((await evalRunning(state)).running).toBe(false)
  })
})
