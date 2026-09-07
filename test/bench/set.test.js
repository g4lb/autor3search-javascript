import { describe, expect, it } from 'vitest'
import { BenchSet, UNIT_BYTES, UNIT_TIME } from '../../src/bench/set.js'

const seeded = () => {
  const s = new BenchSet()
  s.record('f.bench.js > parse > big', 'parse', UNIT_TIME, 1e-6)
  s.record('f.bench.js > parse > big', 'parse', UNIT_TIME, 2e-6)
  s.record('f.bench.js > parse > big', 'parse', UNIT_BYTES, 512)
  s.record('f.bench.js > format', 'format', UNIT_TIME, 3e-6)
  return s
}

describe('BenchSet', () => {
  it('lists names sorted', () => {
    expect(seeded().names()).toEqual(['f.bench.js > format', 'f.bench.js > parse > big'])
  })

  it('lists bases sorted and deduplicated', () => {
    const s = seeded()
    s.record('f.bench.js > parse > small', 'parse', UNIT_TIME, 4e-6)
    expect(s.bases()).toEqual(['format', 'parse'])
  })

  it('keeps observations in the order they were recorded', () => {
    expect(seeded().values('f.bench.js > parse > big', UNIT_TIME)).toEqual([1e-6, 2e-6])
  })

  it('returns null for an unknown name or unit', () => {
    const s = seeded()
    expect(s.values('nope', UNIT_TIME)).toBeNull()
    expect(s.values('f.bench.js > format', UNIT_BYTES)).toBeNull()
  })

  it('returns a defensive copy the caller cannot use to mutate the set', () => {
    const s = seeded()
    const v = s.values('f.bench.js > parse > big', UNIT_TIME)
    v.push(999)
    v.sort()
    expect(s.values('f.bench.js > parse > big', UNIT_TIME)).toEqual([1e-6, 2e-6])
  })

  it('answers has() without copying', () => {
    const s = seeded()
    expect(s.has('f.bench.js > parse > big', UNIT_BYTES)).toBe(true)
    expect(s.has('f.bench.js > format', UNIT_BYTES)).toBe(false)
  })

  it('appends another set into this one', () => {
    const a = seeded()
    const b = new BenchSet()
    b.record('f.bench.js > parse > big', 'parse', UNIT_TIME, 5e-6)
    a.add(b)
    expect(a.values('f.bench.js > parse > big', UNIT_TIME)).toEqual([1e-6, 2e-6, 5e-6])
  })

  it('selects by base name, matching every sub-benchmark of it', () => {
    const s = seeded()
    s.record('f.bench.js > parse > small', 'parse', UNIT_TIME, 4e-6)
    expect(s.selectByBase(['parse']).names()).toEqual([
      'f.bench.js > parse > big',
      'f.bench.js > parse > small',
    ])
  })

  it('selects everything when the base list is empty', () => {
    expect(seeded().selectByBase([]).names()).toEqual(seeded().names())
  })

  it('returns an independent set from selectByBase', () => {
    const s = seeded()
    const sub = s.selectByBase(['parse'])
    sub.record('f.bench.js > parse > big', 'parse', UNIT_TIME, 9e-6)
    expect(s.values('f.bench.js > parse > big', UNIT_TIME)).toHaveLength(2)
  })
})
