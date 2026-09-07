import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as gitx from '../src/gitx.js'
import { loadRows } from '../src/results.js'
import { STATE_HOME_ENV, stateDir } from '../src/state/index.js'
import { runCli } from './helpers/cli.js'
import { FAST_WORDCOUNT, makeBenchRepo } from './helpers/bench-repo.js'
import { commitFiles, git, writeFiles } from './helpers/repo.js'

const original = process.env[STATE_HOME_ENV]
beforeEach(async () => {
  process.env[STATE_HOME_ENV] = await mkdtemp(join(tmpdir(), 'a3s-e2e-home-'))
})
afterEach(() => {
  if (original === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = original
})

/** A fast, low-count config so the suite stays under its timeout. */
const FAST_CONFIG = `benchmarks: ["countWords"]
count: 4
scope: ["src/**"]
heap_hint: false
timeout: 5m
`

const evalJson = async (dir, desc) => {
  const { code, out } = await runCli(['eval', '-C', dir, '--json', '-desc', desc])
  return { code, payload: JSON.parse(out) }
}

describe('a full session', () => {
  it('runs init, baseline, four experiments and report', async () => {
    const dir = await makeBenchRepo()

    // --- init -----------------------------------------------------------
    expect((await runCli(['init', '-C', dir])).code).toBe(0)
    await writeFiles(dir, { '.autor3search/config.yaml': FAST_CONFIG })
    await commitFiles(dir, {}, 'autor3search-javascript init')

    // --- doctor ---------------------------------------------------------
    expect((await runCli(['doctor', '-C', dir])).code).toBe(0)

    // --- baseline -------------------------------------------------------
    expect((await runCli(['baseline', '-C', dir, '-tag', 'e2e'])).code).toBe(0)
    expect(await gitx.currentBranch(dir)).toBe('autor3search-javascript/e2e')
    const frozenCommit = await gitx.headCommit(dir)

    // --- experiment 1: a scope violation --------------------------------
    await commitFiles(dir, { 'elsewhere/x.js': 'export const x = 1\n' }, 'edit outside scope')
    const scope = await evalJson(dir, 'edit outside scope')
    expect(scope.code).toBe(2)
    expect(scope.payload.reason).toBe('scope_violation')
    await git(dir, 'reset', '--hard', 'HEAD~1')

    // --- experiment 2: a weakened test is restored, not obeyed -----------
    await commitFiles(
      dir,
      { 'src/wordcount.test.js': `import { test } from 'vitest'\ntest('nothing', () => {})\n` },
      'weaken the test',
    )
    await evalJson(dir, 'weaken the test')
    expect(await readFile(join(dir, 'src/wordcount.test.js'), 'utf8')).toMatch(/counts words/)
    await git(dir, 'reset', '--hard', 'HEAD~1')

    // --- experiment 3: a broken implementation fails the test gate -------
    await commitFiles(dir, { 'src/wordcount.js': 'export function countWords() { return {} }\n' }, 'break it')
    const broken = await evalJson(dir, 'break it')
    expect(broken.code).toBe(2)
    expect(broken.payload.reason).toBe('tests_failed')
    await git(dir, 'reset', '--hard', 'HEAD~1')

    // --- experiment 4: a real improvement --------------------------------
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT }, 'faster word counter')
    const fast = await evalJson(dir, 'faster word counter')
    expect([0, 1]).toContain(fast.code) // KEEP on a quiet machine, DISCARD on a noisy one
    expect(fast.payload.deltas).toHaveLength(1)
    if (fast.code === 0) {
      expect(fast.payload.status).toBe('KEEP')
      // A KEEP advances the measurement baseline past the frozen anchor.
      expect(fast.payload.run.measure_commit).not.toBe(frozenCommit)
      expect(fast.payload.run.baseline_commit).toBe(frozenCommit)
    } else {
      await git(dir, 'reset', '--hard', 'HEAD~1')
    }

    // --- the log ---------------------------------------------------------
    const rows = await loadRows(join(dir, 'results.tsv'))
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.description)).toEqual([
      'edit outside scope',
      'weaken the test',
      'break it',
      'faster word counter',
    ])

    // --- report ----------------------------------------------------------
    const report = await runCli(['report', '-C', dir])
    expect(report.code).toBe(0)
    expect(report.out).toMatch(/total\s+4/)

    // --- status ----------------------------------------------------------
    const status = await runCli(['status', '-C', dir])
    expect(status.out).toMatch(/4 run/)
    expect(status.out).toMatch(/next is #5/)
  })

  it('reports a stop request on the next verdict and lets it be cleared', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    await writeFiles(dir, { '.autor3search/config.yaml': FAST_CONFIG })
    await commitFiles(dir, {}, 'init')
    await runCli(['baseline', '-C', dir, '-tag', 'e2e'])

    await runCli(['stop', '-C', dir])
    await commitFiles(dir, { 'src/wordcount.js': FAST_WORDCOUNT }, 'faster')
    const stopped = await evalJson(dir, 'faster')
    expect(stopped.payload.stop_requested).toBe(true)
    expect(['KEEP', 'DISCARD']).toContain(stopped.payload.status)

    await runCli(['stop', '-C', dir, '--clear'])
    const { stopRequested } = await import('../src/state/stop.js')
    expect(await stopRequested(await stateDir(dir, 'e2e'))).toBe(false)
  })

  it('refuses to start a run on a repository with no benchmarks', async () => {
    const { makeRepo } = await import('./helpers/repo.js')
    const dir = await makeRepo({ 'src/a.js': 'export const a = 1\n' })
    const { code, err } = await runCli(['init', '-C', dir])
    expect(code).not.toBe(0)
    expect(err).toMatch(/no benchmarks/i)
  })
})
