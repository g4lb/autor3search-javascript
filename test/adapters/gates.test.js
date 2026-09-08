import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runGates } from '../../src/adapters/gates/index.js'
import { resolveFrom } from '../../src/adapters/gates/util.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'
import { writeFiles } from '../helpers/repo.js'

/** This project's own root — it has vitest installed, so it doubles as a "known resolvable" fixture. */
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const auto = { typecheck: 'auto', lint: 'auto', test: 'auto' }
const base = { modes: auto, scope: ['**'], timeoutMs: 120_000 }
const byName = (outcomes, name) => outcomes.find((o) => o.name === name)

describe('runGates', () => {
  it('passes every gate on a healthy repository', async () => {
    const dir = await makeBenchRepo()
    const outcomes = await runGates(dir, base)
    expect(outcomes.map((o) => o.name)).toEqual(['typecheck', 'lint', 'test'])
    expect(outcomes.every((o) => o.ok)).toBe(true)
  })

  it('skips lint when the repository has no ESLint config', async () => {
    const dir = await makeBenchRepo()
    const lint = byName(await runGates(dir, base), 'lint')
    expect(lint.ran).toBe(false)
    expect(lint.ok).toBe(true)
    expect(lint.skipped).toMatch(/no ESLint config/i)
  })

  it('parse-checks in-scope sources when there is no tsconfig', async () => {
    const dir = await makeBenchRepo()
    const tc = byName(await runGates(dir, base), 'typecheck')
    expect(tc.ran).toBe(true)
    expect(tc.detail).toMatch(/parse/i)
  })

  it('fails the parse check on a syntactically broken in-scope file', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'src/broken.js': 'export function ( { <<< nope\n' })
    const tc = byName(await runGates(dir, base), 'typecheck')
    expect(tc.ok).toBe(false)
    expect(tc.detail).toContain('src/broken.js')
  })

  it('ignores a broken file outside scope', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'scratch/broken.js': 'export function ( { <<< nope\n' })
    const tc = byName(await runGates(dir, { ...base, scope: ['src/**'] }), 'typecheck')
    expect(tc.ok).toBe(true)
  })

  it('fails the test gate when a test fails', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'src/wordcount.js': 'export function countWords() { return {} }\n' })
    const test = byName(await runGates(dir, base), 'test')
    expect(test.ok).toBe(false)
    expect(test.detail.length).toBeGreaterThan(0)
  })

  it('never runs a gate set to off', async () => {
    const dir = await makeBenchRepo()
    const outcomes = await runGates(dir, { ...base, modes: { ...auto, test: 'off' } })
    const test = byName(outcomes, 'test')
    expect(test.ran).toBe(false)
    expect(test.ok).toBe(true)
    expect(test.skipped).toMatch(/off/)
  })

  it('fails a gate set to on that cannot run, rather than skipping it', async () => {
    const dir = await makeBenchRepo()
    const lint = byName(await runGates(dir, { ...base, modes: { ...auto, lint: 'on' } }), 'lint')
    expect(lint.ok).toBe(false)
    expect(lint.detail).toMatch(/gates\.lint is "on"/)
  })

  it('stops at the first failing gate rather than running the rest', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'src/broken.js': 'export function ( { <<< nope\n' })
    const outcomes = await runGates(dir, base)
    expect(outcomes.map((o) => o.name)).toEqual(['typecheck'])
  })

  it('reports a parse-only typecheck as degraded when tsconfig exists without typescript', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n' })
    const tc = byName(await runGates(dir, base), 'typecheck')
    expect(tc.ran).toBe(true)
    expect(tc.ok).toBe(true)
    expect(tc.degraded).toBe(true)
    expect(tc.detail).toMatch(/types were not checked/)
  })

  it('fails a degraded typecheck when the user set gates.typecheck to on', async () => {
    // Requiring type checking and silently receiving syntax checking is the
    // same defect as the gate vanishing, but harder to notice.
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n' })
    const tc = byName(await runGates(dir, { ...base, modes: { ...auto, typecheck: 'on' } }), 'typecheck')
    expect(tc.ok).toBe(false)
    expect(tc.detail).toMatch(/degraded/)
  })

  it('does not mark a plain-JS repo parse check as degraded', async () => {
    const dir = await makeBenchRepo()
    const tc = byName(await runGates(dir, base), 'typecheck')
    expect(tc.degraded).toBeFalsy()
    expect(tc.ok).toBe(true)
  })

  it('stops after the first gate when the caller already aborted', async () => {
    // An already-aborted signal must short-circuit as soon as it is observed
    // — the remaining gates would only spend minutes producing output nobody
    // will read, exactly like a genuine failure stops the loop early.
    const dir = await makeBenchRepo()
    const controller = new AbortController()
    controller.abort()
    const outcomes = await runGates(dir, { ...base, signal: controller.signal })
    expect(outcomes.map((o) => o.name)).toEqual(['typecheck'])
  })
})

describe('resolveFrom', () => {
  it('resolves a package from a RELATIVE directory, not just an absolute one', () => {
    // createRequire throws on a relative path and the catch turns that into
    // null — a false "not installed" that looks identical to the real thing.
    // This project's own root has vitest installed, so a relative path to
    // it from cwd is a known-resolvable fixture.
    const relativeRoot = relative(process.cwd(), PROJECT_ROOT)
    expect(resolveFrom(relativeRoot, 'vitest/vitest.mjs')).not.toBeNull()
  })
})
