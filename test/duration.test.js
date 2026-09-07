import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration } from '../src/duration.js'

describe('parseDuration', () => {
  it('parses plain second, minute and hour units', () => {
    expect(parseDuration('1s')).toBe(1000)
    expect(parseDuration('15m')).toBe(900_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('parses sub-second units', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('250us')).toBeCloseTo(0.25, 10)
    expect(parseDuration('1000ns')).toBeCloseTo(0.001, 10)
  })

  it('parses fractional and compound values', () => {
    expect(parseDuration('1.5s')).toBe(1500)
    expect(parseDuration('1m30s')).toBe(90_000)
    expect(parseDuration('1h2m3s')).toBe(3_723_000)
  })

  it('rejects an empty or unitless value', () => {
    expect(() => parseDuration('')).toThrow(/not a duration/)
    expect(() => parseDuration('10')).toThrow(/not a duration/)
    expect(() => parseDuration('abc')).toThrow(/not a duration/)
  })

  it('rejects a negative duration', () => {
    expect(() => parseDuration('-5s')).toThrow(/not a duration/)
  })

  it('rejects an unknown unit', () => {
    expect(() => parseDuration('5days')).toThrow(/not a duration/)
  })
})

describe('formatDuration', () => {
  it('renders a human-readable duration', () => {
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(250)).toBe('250ms')
    expect(formatDuration(90_000)).toBe('1m30s')
  })
})
