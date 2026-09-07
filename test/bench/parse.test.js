import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UNIT_TIME } from '../../src/bench/set.js'
import { parseVitestBench } from '../../src/bench/parse.js'

const fixture = async () =>
  JSON.parse(await readFile(fileURLToPath(new URL('../fixtures/vitest-bench.json', import.meta.url)), 'utf8'))

describe('parseVitestBench', () => {
  it('finds every benchmark in the captured fixture', async () => {
    const set = parseVitestBench(await fixture())
    expect(set.bases().sort()).toEqual(['concat', 'join', 'toplevel'])
  })

  it('records exactly one observation per benchmark per parse', async () => {
    const set = parseVitestBench(await fixture())
    for (const name of set.names()) {
      expect(set.values(name, UNIT_TIME)).toHaveLength(1)
    }
  })

  it('converts milliseconds to seconds', async () => {
    const set = parseVitestBench(await fixture())
    for (const name of set.names()) {
      const [value] = set.values(name, UNIT_TIME)
      // Any real microbenchmark is well under a second and well above a
      // femtosecond; this catches a unit conversion applied twice or not at all.
      expect(value).toBeGreaterThan(1e-12)
      expect(value).toBeLessThan(1)
    }
  })

  it('builds a task path that includes the enclosing suite', async () => {
    const set = parseVitestBench(await fixture())
    expect(set.names().some((n) => n.includes('concat'))).toBe(true)
    const concat = set.names().find((n) => n.endsWith('concat'))
    expect(concat).toMatch(/strings/)
  })

  it('uses the leaf name as the base, so config.benchmarks can select on it', async () => {
    const set = parseVitestBench(await fixture())
    expect(set.bases()).toContain('concat')
  })

  it('accepts the payload as a JSON string as well as an object', async () => {
    const raw = JSON.stringify(await fixture())
    expect(parseVitestBench(raw).bases()).toEqual(parseVitestBench(await fixture()).bases())
  })

  it('throws a shape error naming what it saw, rather than returning nothing', () => {
    // A silently changed reporter format that yielded an empty set would
    // present as "no benchmarks matched", which reads like a user error and
    // is not one.
    expect(() => parseVitestBench({ unexpected: true })).toThrow(/unrecognised/i)
    expect(() => parseVitestBench({ unexpected: true })).toThrow(/unexpected/)
  })

  it('throws when the payload parses but contains no benchmark at all', () => {
    expect(() => parseVitestBench({ files: [] })).toThrow(/no benchmarks/i)
  })

  it('throws on a benchmark with no usable timing', () => {
    expect(() =>
      parseVitestBench({ files: [{ filepath: 'a.bench.js', groups: [{ fullName: 'a.bench.js', benchmarks: [{ name: 'x' }] }] }] }),
    ).toThrow(/no timing/i)
  })

  it('rejects invalid JSON with the excerpt included', () => {
    expect(() => parseVitestBench('{not json')).toThrow(/parse/i)
  })
})
