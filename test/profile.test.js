import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROFILE_DIR, topFunctions } from '../src/profile.js'
import { runCli } from './helpers/cli.js'
import { makeBenchRepo } from './helpers/bench-repo.js'
import { commitFiles } from './helpers/repo.js'

/** A minimal, valid .cpuprofile: 10ms in hot, 5ms in cold. */
const SAMPLE_PROFILE = {
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2, 3] },
    { id: 2, callFrame: { functionName: 'hot', url: 'file:///a.js' } },
    { id: 3, callFrame: { functionName: 'cold', url: 'file:///a.js' } },
  ],
  samples: [2, 2, 3],
  timeDeltas: [5000, 5000, 5000],
  startTime: 0,
  endTime: 15000,
}

describe('topFunctions', () => {
  it('ranks functions by self time', () => {
    const top = topFunctions(SAMPLE_PROFILE, 10)
    expect(top[0].name).toBe('hot')
    expect(top[0].selfMs).toBeCloseTo(10, 5)
    expect(top[1].name).toBe('cold')
  })

  it('reports the share of total time for each function', () => {
    const [first] = topFunctions(SAMPLE_PROFILE, 10)
    expect(first.pct).toBeCloseTo(66.67, 1)
  })

  it('honours the limit', () => {
    expect(topFunctions(SAMPLE_PROFILE, 1)).toHaveLength(1)
  })

  it('names the source file for each entry', () => {
    expect(topFunctions(SAMPLE_PROFILE, 10)[0].file).toContain('a.js')
  })

  it('returns an empty list for a profile with no samples', () => {
    expect(topFunctions({ nodes: [], samples: [], timeDeltas: [] }, 10)).toEqual([])
  })

  it('filters out V8 synthetic frames', () => {
    const withSynthetic = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '' } },
        { id: 2, callFrame: { functionName: '(program)', url: '' } },
        { id: 3, callFrame: { functionName: '(idle)', url: '' } },
        { id: 4, callFrame: { functionName: '(garbage collector)', url: '' } },
        { id: 5, callFrame: { functionName: 'real', url: 'file:///a.js' } },
      ],
      samples: [1, 2, 3, 4, 5],
      timeDeltas: [1000, 1000, 1000, 1000, 1000],
    }
    const names = topFunctions(withSynthetic, 10).map((e) => e.name)
    expect(names).toEqual(['real'])
  })
})

describe('profile command', () => {
  async function ready() {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    await commitFiles(dir, {}, 'init')
    return dir
  }

  it('writes cpu and heap profiles under .autor3search/profiles', async () => {
    const dir = await ready()
    const { code } = await runCli(['profile', '-C', dir])
    expect(code).toBe(0)
    const written = await readdir(join(dir, PROFILE_DIR), { recursive: true })
    expect(written.some((f) => String(f).endsWith('cpu.cpuprofile'))).toBe(true)
    expect(written.some((f) => String(f).endsWith('heap.heapprofile'))).toBe(true)
  })

  it('prints a hot-spot table', async () => {
    const { out } = await runCli(['profile', '-C', await ready()])
    expect(out).toMatch(/self ms/i)
    expect(out).toMatch(/%/)
  })

  it('tells the human how to open the raw profiles', async () => {
    const { out } = await runCli(['profile', '-C', await ready()])
    expect(out).toMatch(/DevTools|speedscope/i)
  })

  it('writes a cpu profile that parses as JSON with nodes and samples', async () => {
    const dir = await ready()
    await runCli(['profile', '-C', dir])
    const files = (await readdir(join(dir, PROFILE_DIR), { recursive: true })).map(String)
    const cpu = files.find((f) => f.endsWith('cpu.cpuprofile'))
    const parsed = JSON.parse(await readFile(join(dir, PROFILE_DIR, cpu), 'utf8'))
    expect(Array.isArray(parsed.nodes)).toBe(true)
    expect(Array.isArray(parsed.samples)).toBe(true)
  })

  it('refuses when init has not been run', async () => {
    const dir = await makeBenchRepo()
    const { code, err } = await runCli(['profile', '-C', dir])
    expect(code).not.toBe(0)
    expect(err).toMatch(/init/)
  })

  it('refuses when there are no bench files', async () => {
    const dir = await ready()
    await rm(join(dir, 'src/wordcount.bench.js'))
    await commitFiles(dir, {}, 'remove bench file')
    const { code, err } = await runCli(['profile', '-C', dir])
    expect(code).not.toBe(0)
    expect(err).toMatch(/bench/i)
  })
})
