import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.js'
import * as freeze from '../src/freeze.js'
import * as gitx from '../src/gitx.js'
import { RUN_LOG_NAME, evalOnce } from '../src/pipeline.js'
import { WORKTREE_NAME, benchPattern } from '../src/state/index.js'
import { REASON, STATUS } from '../src/verdict.js'
import { FAST_WORDCOUNT, makeBenchRepo } from './helpers/bench-repo.js'
import { commitFiles, writeFiles } from './helpers/repo.js'

/** Builds a repository with a baseline already recorded, ready for eval. */
async function setup(overrides = {}) {
  const root = await makeBenchRepo()
  const stateDir = await mkdtemp(join(tmpdir(), 'a3s-pipeline-'))

  const cfg = {
    ...defaultConfig(),
    count: 4,
    scope: ['src/**'],
    heapHint: false,
    gates: { typecheck: 'auto', lint: 'auto', test: 'auto' },
    ...overrides,
  }
  await writeFiles(root, { '.autor3search/config.yaml': `count: ${cfg.count}\n` })
  const configSha256 = createHash('sha256')
    .update(await readFile(join(root, '.autor3search/config.yaml')))
    .digest('hex')

  const frozen = ['src/wordcount.test.js', 'src/wordcount.bench.js']
  const manifest = await freeze.snapshot(root, join(stateDir, freeze.STORE_DIR), frozen)
  await freeze.saveManifest(join(stateDir, freeze.MANIFEST_PATH), manifest)

  await gitx.createBranch(root, 'autor3search-javascript/t')
  await commitFiles(root, {}, 'baseline')
  const commit = await gitx.headCommit(root)
  await gitx.addWorktree(root, join(stateDir, WORKTREE_NAME), commit)

  const baseline = {
    tag: 't',
    branch: 'autor3search-javascript/t',
    commit,
    measureCommit: commit,
    createdAt: new Date().toISOString(),
    benchmarks: ['countWords'],
    pattern: benchPattern(['countWords']),
    configSha256,
  }
  return { root, stateDir, cfg, baseline }
}

const run = (ctx) => evalOnce({ ...ctx, log: null })

describe('evalOnce — gates', () => {
  it('fails an out-of-scope edit before anything is built', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'outside/thing.js': 'export const x = 1\n' })
    const { result } = await run(ctx)
    expect(result.status).toBe(STATUS.FAIL)
    expect(result.reason).toBe(REASON.SCOPE)
    expect(result.message).toContain('outside/thing.js')
  })

  it('rejects a package.json change regardless of scope', async () => {
    const ctx = await setup({ scope: ['**'] })
    await commitFiles(ctx.root, { 'package.json': '{"name":"demo","type":"module","x":1}\n' })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.SCOPE)
    expect(result.message).toMatch(/dependency changes are a human decision/)
  })

  it('rejects a lockfile change regardless of scope', async () => {
    const ctx = await setup({ scope: ['**'] })
    await commitFiles(ctx.root, { 'package-lock.json': '{}\n' })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.SCOPE)
  })

  // C2: a committed vitest.config.js is an ordinary root file the default
  // scope (["**"]) would otherwise admit, and Vitest loads it as part of
  // `vitest bench --run` — so, unlike a frozen benchmark file, it is never
  // restored. Before this rejection existed, a `resolve.alias` keyed off
  // `process.argv.includes('bench')` could retarget a frozen benchmark's
  // import to a stub with every other gate green and the frozen file itself
  // untouched — proven end to end against the real Vitest binary during
  // this fix's own verification, not just asserted here against the gate.
  it('rejects a committed vitest.config.js regardless of scope', async () => {
    const ctx = await setup({ scope: ['**'] })
    await commitFiles(ctx.root, {
      'vitest.config.js': `export default { resolve: { alias: process.argv.includes('bench') ? { './wordcount.js': './stub.js' } : {} } }\n`,
    })
    const { result } = await run(ctx)
    expect(result.status).toBe(STATUS.FAIL)
    expect(result.reason).toBe(REASON.SCOPE)
    expect(result.message).toContain('vitest.config.js')
  })

  it('rejects a committed vite.config.ts regardless of scope', async () => {
    const ctx = await setup({ scope: ['**'] })
    await commitFiles(ctx.root, { 'vite.config.ts': 'export default {}\n' })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.SCOPE)
    expect(result.message).toContain('vite.config.ts')
  })

  it('rejects a committed vitest.workspace.json regardless of scope', async () => {
    const ctx = await setup({ scope: ['**'] })
    await commitFiles(ctx.root, { 'vitest.workspace.json': '[]\n' })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.SCOPE)
  })

  // vitest.projects is an alternate name for vitest.workspace (verified
  // against Vitest 2.1.9's own WORKSPACES_NAMES table) that is easy to miss
  // if only the documented name is covered.
  it('rejects a committed vitest.projects.js regardless of scope', async () => {
    const ctx = await setup({ scope: ['**'] })
    await commitFiles(ctx.root, { 'vitest.projects.js': 'export default []\n' })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.SCOPE)
  })

  it('ignores harness-owned files in the scope gate', async () => {
    const ctx = await setup()
    await writeFiles(ctx.root, { 'results.tsv': 'x\n', [RUN_LOG_NAME]: 'y\n' })
    const { result } = await run(ctx)
    expect(result.reason).not.toBe(REASON.SCOPE)
  })

  it('fails when the config changed since baseline', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { '.autor3search/config.yaml': 'count: 99\n' })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.CONFIG_CHANGED)
    expect(result.message).toMatch(/scoring rules are fixed for a run/)
  })

  it('restores a weakened test instead of arguing with it', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/wordcount.test.js': `import { test } from 'vitest'\ntest('nothing', () => {})\n` })
    await run(ctx)
    expect(await readFile(join(ctx.root, 'src/wordcount.test.js'), 'utf8')).toMatch(/counts words/)
  })

  it('restores a rewritten benchmark — the metric is frozen too', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/wordcount.bench.js': `import { bench } from 'vitest'\nbench('countWords', () => {})\n` })
    await run(ctx)
    expect(await readFile(join(ctx.root, 'src/wordcount.bench.js'), 'utf8')).toMatch(/repeat\(200\)/)
  })

  it('fails on a test file that did not exist at baseline', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/extra.test.js': `import { test } from 'vitest'\ntest('x', () => {})\n` })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.NEW_TEST_FILE)
    expect(result.message).toContain('src/extra.test.js')
  })

  it('fails on a bench file that did not exist at baseline', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/easier.bench.js': `import { bench } from 'vitest'\nbench('easy', () => {})\n` })
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.NEW_TEST_FILE)
  })

  // I2: the REVERSE frozen-set integrity check (present vs. manifest). A
  // plain rename of the directory holding a frozen file does NOT reach this
  // branch: `freeze.restore` recreates the file at its exact manifest-recorded
  // relative path via `mkdir(dirname(dst), {recursive:true})` regardless of
  // what else moved, so the walk always finds it again there — verified
  // directly against freeze.js/discover.js before writing this test, and it
  // is why the leftover at the OLD location (still named *.test.js) trips
  // NEW_TEST_FILE instead, one check earlier. The one way to actually hide a
  // restored file from discover.js's walk (which enumerates via `readdir`, a
  // read-permission operation) while leaving it byte-for-byte correct and
  // reachable BY PATH (an exact lookup needs only execute permission) is to
  // strip read permission from its directory — a real "structural change to
  // the tree", and not one that shows up in `git diff` (permissions aren't
  // part of a tracked change), so it does not interact with the scope gate.
  it('fails when a frozen file is restored but its directory cannot be listed', async () => {
    const ctx = await setup()
    await chmod(join(ctx.root, 'src'), 0o111) // execute-only: lookup by path still works, readdir does not
    try {
      const { result } = await run(ctx)
      expect(result.reason).toBe(REASON.MISSING_TEST_FILE)
      expect(result.message).toMatch(/src\/wordcount\.(test|bench)\.js/)
    } finally {
      await chmod(join(ctx.root, 'src'), 0o755) // restore permissions so cleanup can remove the tree
    }
  })

  it('fails when a frozen file was replaced by a symlink', async () => {
    const ctx = await setup()
    await rm(join(ctx.root, 'src/wordcount.test.js'))
    // The symlink target must itself stay IN SCOPE (default scope is
    // 'src/**'): at the repo root it would be an untracked, out-of-scope
    // file in its own right, and the scope gate — which runs before restore
    // — would report SCOPE for that reason instead of exercising the
    // symlink-tamper detection this test means to cover.
    await writeFile(join(ctx.root, 'src/target.js'), 'x\n')
    await symlink(join(ctx.root, 'src/target.js'), join(ctx.root, 'src/wordcount.test.js'))
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.SYMLINK_SWAP)
  })

  it('fails when the frozen store was rewritten', async () => {
    const ctx = await setup()
    await writeFile(join(ctx.stateDir, 'frozen/src/wordcount.test.js'), 'tampered\n')
    await writeFile(join(ctx.root, 'src/wordcount.test.js'), 'edited\n')
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.FROZEN_TAMPERED)
    expect(result.message).toMatch(/start a fresh run/i)
  })

  it('crashes on a syntactically broken in-scope source', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/broken.js': 'export function ( { <<<\n' })
    const { result } = await run(ctx)
    expect(result.status).toBe(STATUS.CRASH)
    expect(result.reason).toBe(REASON.TYPECHECK)
  })

  it('fails when a test fails', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/wordcount.js': 'export function countWords() { return {} }\n' })
    const { result } = await run(ctx)
    expect(result.status).toBe(STATUS.FAIL)
    expect(result.reason).toBe(REASON.TESTS)
  })

  it('fails when the pinned worktree no longer matches the measurement commit', async () => {
    const ctx = await setup()
    const other = await commitFiles(ctx.root, { 'src/x.js': 'export const x = 1\n' })
    await gitx.checkoutDetached(join(ctx.stateDir, WORKTREE_NAME), other)
    const { result } = await run(ctx)
    expect(result.reason).toBe(REASON.BASELINE_TAMPERED)
  })

  // I3: the scope gate deliberately diffs against `baseline.commit` (the
  // FROZEN anchor recorded once at `baseline` time), never `measureCommit`
  // (the pointer that advances past every KEEP) — see the long comment
  // above the scope gate in src/pipeline.js. The existing scope tests above
  // all run BEFORE any KEEP, when the two are numerically equal, so they
  // cannot tell the two anchor choices apart. This test forces them apart:
  // it commits an out-of-scope file, then advances measureCommit AND
  // re-points the pinned worktree past that commit — exactly what
  // `advanceMeasurementBaseline` does on a real KEEP — and asserts the
  // out-of-scope file is STILL caught.
  //
  // Forcing a REAL KEEP here would mean depending on a genuine, statistically
  // significant timing improvement clearing `alpha` on whatever machine runs
  // the suite — exactly the noise the other measurement tests in this file
  // already have to shrug off. Simulating the two effects a KEEP has
  // (`baseline.measureCommit` and the worktree HEAD both moving to the new
  // commit) gets the same anchor configuration deterministically, without
  // needing FAST_WORDCOUNT to actually win a noisy race.
  it('still reports a scope violation after the anchor advances past it, simulating a KEEP', async () => {
    const ctx = await setup()
    const oobCommit = await commitFiles(ctx.root, { 'outside/thing.js': 'export const x = 1\n' })

    // Simulate the KEEP that would ordinarily have carried this commit past
    // the "already accepted" line.
    await gitx.checkoutDetached(join(ctx.stateDir, WORKTREE_NAME), oobCommit)
    ctx.baseline.measureCommit = oobCommit

    const { result } = await run(ctx)
    // If the scope gate anchored on measureCommit instead, the diff against
    // it would be empty (HEAD === measureCommit === oobCommit) and this
    // would fall through to a real measurement instead of SCOPE.
    expect(result.status).toBe(STATUS.FAIL)
    expect(result.reason).toBe(REASON.SCOPE)
    expect(result.message).toContain('outside/thing.js')
  })
})

describe('evalOnce — measurement', () => {
  it('returns a decided verdict and time deltas for a real experiment', async () => {
    const ctx = await setup()
    await commitFiles(ctx.root, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { result, measurements } = await run(ctx)
    expect([STATUS.KEEP, STATUS.DISCARD]).toContain(result.status)
    expect(measurements.time).toHaveLength(1)
    expect(measurements.time[0].name).toMatch(/countWords/)
  })

  // I3 (test hygiene): previously `return`ed with no assertion at all when
  // the verdict came back other than expected — meaningless on a noisy
  // runner, since the very case the test exists to catch (the pointer
  // advancing when it should not, or vice versa) would then silently pass.
  // Both branches now assert something either way: the pointer moves to the
  // new commit on KEEP, and stays put otherwise — whichever the machine's
  // noise level happens to produce this run.
  it('advances the measurement commit and the pinned worktree on KEEP, and only on KEEP', async () => {
    const ctx = await setup()
    const before = ctx.baseline.measureCommit
    const newCommit = await commitFiles(ctx.root, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { result } = await run(ctx)
    const expected = result.status === STATUS.KEEP ? newCommit : before
    expect(ctx.baseline.measureCommit).toBe(expected)
    expect(await gitx.headCommit(join(ctx.stateDir, WORKTREE_NAME))).toBe(expected)
  })

  it('leaves the measurement commit alone on anything but KEEP (a no-op change rarely KEEPs; asserted either way)', async () => {
    const ctx = await setup()
    const before = ctx.baseline.measureCommit
    const newCommit = await commitFiles(ctx.root, { 'src/wordcount.js': `${await readFile(join(ctx.root, 'src/wordcount.js'), 'utf8')}\n// comment\n` })
    const { result } = await run(ctx)
    expect(ctx.baseline.measureCommit).toBe(result.status === STATUS.KEEP ? newCommit : before)
  })

  it('never lets the bytes hint reach the scored deltas', async () => {
    const ctx = await setup({ heapHint: true })
    await commitFiles(ctx.root, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { measurements } = await run(ctx)
    expect(measurements.time.every((d) => d.unit === 'sec/op')).toBe(true)
  })

  // This is the real cross-directory shape the bytes/op hint is measured
  // under: baseDir is the pinned baseline worktree (join(stateDir,
  // WORKTREE_NAME)) and candDir is the repository root (ctx.root) — two
  // different absolute paths for the same tree. Before the fix in
  // src/adapters/driver.js, measureHeap keyed each observation by the
  // ABSOLUTE resolved bench file path, which differs on the two sides and so
  // compareAll(UNIT_BYTES) always threw "missing from the candidate" —
  // silently degrading measurements.bytes to null on every real run. This
  // asserts the hint actually SURVIVES that real shape, not merely that a
  // missing hint cannot break the verdict.
  it('produces a real bytes/op delta across the baseline worktree and the repo root', async () => {
    const ctx = await setup({ heapHint: true })
    await commitFiles(ctx.root, { 'src/wordcount.js': FAST_WORDCOUNT })
    const { measurements } = await run(ctx)
    expect(measurements.bytes).not.toBeNull()
    expect(measurements.bytes.length).toBeGreaterThan(0)
    expect(measurements.bytes.some((d) => d.name.includes('countWords'))).toBe(true)
    expect(measurements.bytes.every((d) => d.unit === 'bytes/op')).toBe(true)
  })
})
