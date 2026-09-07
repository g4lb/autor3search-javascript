import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STATE_HOME_ENV, stateDir } from '../../src/state/index.js'
import { claimEval } from '../../src/state/lock.js'
import { requestStop } from '../../src/state/stop.js'
import { loadRows } from '../../src/results.js'
import { runCli } from '../helpers/cli.js'
import { FAST_WORDCOUNT, makeBenchRepo } from '../helpers/bench-repo.js'
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
})
