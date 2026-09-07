import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig, validate } from '../src/config.js'

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a3s-config-'))
})

async function write(yaml) {
  const path = join(dir, 'config.yaml')
  await writeFile(path, yaml)
  return path
}

describe('defaultConfig', () => {
  it('matches the documented defaults', () => {
    expect(defaultConfig()).toEqual({
      benchmarks: [],
      scope: ['**'],
      count: 10,
      benchtime: '1s',
      maxRegressPct: 5,
      minEffectPct: 1,
      timeout: '15m',
      unfreeze: [],
      runner: 'vitest',
      heapHint: true,
      gates: { typecheck: 'auto', lint: 'auto', test: 'auto' },
    })
  })
})

describe('loadConfig', () => {
  it('applies defaults for omitted fields', async () => {
    const cfg = await loadConfig(await write('count: 8\n'))
    expect(cfg.count).toBe(8)
    expect(cfg.benchtime).toBe('1s')
    expect(cfg.scope).toEqual(['**'])
  })

  it('translates snake_case keys to camelCase', async () => {
    const cfg = await loadConfig(await write('max_regress_pct: 2.5\nmin_effect_pct: 0.5\nheap_hint: false\n'))
    expect(cfg.maxRegressPct).toBe(2.5)
    expect(cfg.minEffectPct).toBe(0.5)
    expect(cfg.heapHint).toBe(false)
  })

  it('merges gates over the defaults rather than replacing the object', async () => {
    const cfg = await loadConfig(await write('gates:\n  lint: off\n'))
    expect(cfg.gates).toEqual({ typecheck: 'auto', lint: 'off', test: 'auto' })
  })

  it('reports the path when the file does not parse', async () => {
    await expect(loadConfig(await write('count: [unclosed\n'))).rejects.toThrow(/config\.yaml/)
  })
})

describe('validate', () => {
  const ok = () => defaultConfig()

  it('accepts the defaults', () => {
    expect(() => validate(ok())).not.toThrow()
  })

  it('refuses a count below 4 and explains why', () => {
    expect(() => validate({ ...ok(), count: 3 })).toThrow(/at least 4/)
    expect(() => validate({ ...ok(), count: 3 })).toThrow(/every experiment would be discarded/)
  })

  it('refuses the fixed-iteration-count benchtime form with an explanation', () => {
    expect(() => validate({ ...ok(), benchtime: '100x' })).toThrow(/fixed-iteration-count/)
    expect(() => validate({ ...ok(), benchtime: '100x' })).toThrow(/thermal/)
  })

  it('refuses a benchtime that is not a duration', () => {
    expect(() => validate({ ...ok(), benchtime: 'soon' })).toThrow(/not a duration/)
  })

  it('refuses a negative max_regress_pct', () => {
    expect(() => validate({ ...ok(), maxRegressPct: -1 })).toThrow(/max_regress_pct/)
  })

  it('refuses a min_effect_pct outside [0, 100)', () => {
    expect(() => validate({ ...ok(), minEffectPct: -0.1 })).toThrow(/min_effect_pct/)
    expect(() => validate({ ...ok(), minEffectPct: 100 })).toThrow(/min_effect_pct/)
  })

  it('refuses an empty scope', () => {
    expect(() => validate({ ...ok(), scope: [] })).toThrow(/at least one path pattern/)
  })

  it('refuses a blank scope entry rather than treating it as the repository root', () => {
    expect(() => validate({ ...ok(), scope: ['src/**', '   '] })).toThrow(/empty or whitespace-only/)
  })

  it('refuses an unknown gate mode', () => {
    expect(() => validate({ ...ok(), gates: { typecheck: 'maybe', lint: 'auto', test: 'auto' } }))
      .toThrow(/gates\.typecheck/)
  })

  it('refuses an unknown runner rather than silently falling back', () => {
    expect(() => validate({ ...ok(), runner: 'jest' })).toThrow(/runner/)
  })

  it('refuses a non-boolean heap_hint', () => {
    expect(() => validate({ ...ok(), heapHint: 'yes' })).toThrow(/heap_hint/)
  })

  it('refuses a timeout that is not a duration', () => {
    expect(() => validate({ ...ok(), timeout: 'later' })).toThrow(/not a duration/)
  })
})
