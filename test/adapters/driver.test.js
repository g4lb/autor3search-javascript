import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UNIT_BYTES } from '../../src/bench/set.js'
import { collectTasks, measureHeap, runProfiled } from '../../src/adapters/driver.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'
import { writeFiles } from '../helpers/repo.js'

const base = { benchmarks: [], iterations: 200, timeoutMs: 120_000 }

describe('collectTasks', () => {
  it('lists the benchmarks a bench file registers', async () => {
    const dir = await makeBenchRepo()
    expect(await collectTasks(join(dir, 'src/wordcount.bench.js'))).toEqual([
      { name: 'countWords', path: 'countWords' },
    ])
  })

  it('includes the describe chain in the path', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, {
      'src/wordcount.bench.js': `import { bench, describe } from 'vitest'
describe('outer', () => { bench('inner', () => {}) })
`,
    })
    expect(await collectTasks(join(dir, 'src/wordcount.bench.js'))).toEqual([
      { name: 'inner', path: 'outer > inner' },
    ])
  })
})

describe('measureHeap', () => {
  it('records one bytes/op observation per benchmark', async () => {
    const dir = await makeBenchRepo()
    const set = await measureHeap(dir, { ...base, benchFiles: ['src/wordcount.bench.js'] })
    expect(set.bases()).toEqual(['countWords'])
    expect(set.values(set.names()[0], UNIT_BYTES)).toHaveLength(1)
  })

  it('reports a positive per-operation byte figure for an allocating benchmark', async () => {
    const dir = await makeBenchRepo()
    const set = await measureHeap(dir, { ...base, benchFiles: ['src/wordcount.bench.js'] })
    const [bytes] = set.values(set.names()[0], UNIT_BYTES)
    expect(bytes).toBeGreaterThan(0)
  })

  it('honours the name filter', async () => {
    const dir = await makeBenchRepo()
    const set = await measureHeap(dir, {
      ...base,
      benchFiles: ['src/wordcount.bench.js'],
      benchmarks: ['nothingNamedThis'],
    })
    expect(set.names()).toEqual([])
  })

  it('returns an empty set rather than throwing when a bench file will not load', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, { 'src/wordcount.bench.js': 'this is not valid javascript <<<\n' })
    const notes = []
    const set = await measureHeap(dir, {
      ...base,
      benchFiles: ['src/wordcount.bench.js'],
      log: { write: (s) => notes.push(s) },
    })
    expect(set.names()).toEqual([])
  })

  it('omits an observation when a collection ran mid-loop rather than reporting a negative', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, {
      'src/wordcount.bench.js': `import { bench } from 'vitest'
// Allocates enough to force a collection inside the measured window.
bench('churn', () => { const a = new Array(200_000).fill(0); return a.length })
`,
    })
    const set = await measureHeap(dir, { ...base, benchFiles: ['src/wordcount.bench.js'], iterations: 300 })
    for (const name of set.names()) {
      const [bytes] = set.values(name, UNIT_BYTES)
      expect(bytes).toBeGreaterThan(0)
    }
  })
})

describe('runProfiled', () => {
  it('writes a CPU profile and a heap profile', async () => {
    const dir = await makeBenchRepo()
    const outDir = join(dir, '.autor3search', 'profiles', 'wordcount')
    const out = await runProfiled(dir, {
      ...base,
      benchFiles: ['src/wordcount.bench.js'],
      outDir,
      iterations: 100,
    })
    const written = await readdir(outDir)
    expect(written.some((f) => f.endsWith('.cpuprofile'))).toBe(true)
    expect(written.some((f) => f.endsWith('.heapprofile'))).toBe(true)
    expect(out.cpuProfile).toContain(outDir)
  })

  it('returns the main thread profile, not the module-loader thread profile', async () => {
    // --cpu-prof profiles the module.register loader thread too. Its profile
    // is valid, non-empty and contains no user code at all, so picking the
    // wrong one yields a confident hot-spot table for Node's module loader.
    const dir = await makeBenchRepo()
    const outDir = join(dir, '.autor3search', 'profiles', 'wordcount')
    const out = await runProfiled(dir, {
      ...base,
      benchFiles: ['src/wordcount.bench.js'],
      outDir,
      iterations: 200,
    })
    const cpu = JSON.parse(await readFile(out.cpuProfile, 'utf8'))
    const urls = cpu.nodes.map((n) => n.callFrame?.url ?? '').join('\n')
    expect(urls).toMatch(/wordcount/)
  })
})
