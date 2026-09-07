import { describe, expect, it } from 'vitest'
import { UNIT_TIME } from '../../src/bench/set.js'
import { getBenchRunner, vitestRunner } from '../../src/adapters/bench/index.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'

const opts = { benchmarks: [], timeoutMs: 120_000 }

describe('getBenchRunner', () => {
  it('returns the vitest adapter by name', () => {
    expect(getBenchRunner('vitest')).toBe(vitestRunner)
  })

  it('throws for an unregistered runner rather than falling back', () => {
    expect(() => getBenchRunner('jest')).toThrow(/not a registered bench adapter/)
  })
})

describe('vitestRunner.run', () => {
  it('measures a real repository and returns one observation per benchmark', async () => {
    const dir = await makeBenchRepo()
    const set = await vitestRunner.run(dir, opts)
    expect(set.bases()).toEqual(['countWords'])
    expect(set.values(set.names()[0], UNIT_TIME)).toHaveLength(1)
  })

  it('produces a plausible per-operation time', async () => {
    const dir = await makeBenchRepo()
    const set = await vitestRunner.run(dir, opts)
    const [value] = set.values(set.names()[0], UNIT_TIME)
    expect(value).toBeGreaterThan(0)
    expect(value).toBeLessThan(1)
  })

  it('filters to the named benchmarks', async () => {
    const dir = await makeBenchRepo()
    await expect(vitestRunner.run(dir, { ...opts, benchmarks: ['nothingMatchesThis'] })).rejects.toThrow(
      /no benchmarks matched/i,
    )
  })

  it('reports a failing bench run with an excerpt rather than an empty set', async () => {
    const dir = await makeBenchRepo()
    const { writeFiles } = await import('../helpers/repo.js')
    await writeFiles(dir, { 'src/wordcount.bench.js': `import { bench } from 'vitest'\nthrow new Error('boom')\n` })
    await expect(vitestRunner.run(dir, opts)).rejects.toThrow(/boom|bench run failed/i)
  })

  it('passes extra environment variables through to the benchmark process', async () => {
    const dir = await makeBenchRepo()
    const { writeFiles } = await import('../helpers/repo.js')
    await writeFiles(dir, {
      'src/wordcount.bench.js': `import { bench } from 'vitest'
if (process.env.A3S_PROBE !== 'set') throw new Error('env not propagated')
bench('countWords', () => { Math.sqrt(2) })
`,
    })
    const set = await vitestRunner.run(dir, { ...opts, env: { ...process.env, A3S_PROBE: 'set' } })
    expect(set.bases()).toEqual(['countWords'])
  })

  it('cleans up its temporary report file', async () => {
    const dir = await makeBenchRepo()
    await vitestRunner.run(dir, opts)
    const { readdir } = await import('node:fs/promises')
    const leftovers = (await readdir(dir)).filter((f) => f.startsWith('.a3s-bench'))
    expect(leftovers).toEqual([])
  })
})
