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

  it('rejects a misspelled gate name instead of ignoring it', async () => {
    // `tests` is the plural typo a user makes when they mean `test`. Merged
    // blindly it lands as a key nothing reads, the real `test` gate stays at
    // "auto" — which may skip the gate altogether — and the baseline hash
    // locks that in for the whole unattended run. Same failure as an unknown
    // top-level setting, one level down, so it fails the same way.
    await expect(loadConfig(await write('gates:\n  tests: "on"\n'))).rejects.toThrow(
      /unknown gate "tests" under 'gates' — known gates are: typecheck, lint, test/,
    )
  })

  it('names every legal gate when it rejects an unknown one', async () => {
    await expect(loadConfig(await write('gates:\n  typecheeck: "on"\n'))).rejects.toThrow(
      /typecheck, lint, test/,
    )
  })

  it('does not let a gates entry reach the prototype of the merged object', async () => {
    // Object.assign uses [[Set]], so a `__proto__` entry under `gates:` would
    // invoke the inherited setter and swap the prototype of cfg.gates rather
    // than land as a key. Object.prototype itself was never reachable, but the
    // merged object must stay an ordinary object.
    const load = loadConfig(await write('gates:\n  __proto__:\n    polluted: true\n'))
    await expect(load).rejects.toThrow(/unknown gate/)
    expect({}.polluted).toBeUndefined()
  })

  it('still accepts every legal gate name and mode', async () => {
    const cfg = await loadConfig(await write('gates:\n  typecheck: "on"\n  lint: off\n  test: auto\n'))
    expect(cfg.gates).toEqual({ typecheck: 'on', lint: 'off', test: 'auto' })
  })

  it('reports the path when the file does not parse', async () => {
    await expect(loadConfig(await write('count: [unclosed\n'))).rejects.toThrow(/config\.yaml/)
  })

  it('rejects a mistyped setting instead of silently keeping the default', async () => {
    // The whole point: `max_regres_pct: 999` must not leave maxRegressPct at 5
    // while stashing a stray property nothing reads.
    await expect(loadConfig(await write('max_regres_pct: 999\n'))).rejects.toThrow(/unknown setting/)
    await expect(loadConfig(await write('max_regres_pct: 999\n'))).rejects.toThrow(/max_regres_pct/)
  })

  it('names the legal settings when it rejects an unknown one', async () => {
    await expect(loadConfig(await write('nonsense: 1\n'))).rejects.toThrow(/max_regress_pct/)
  })

  it('rejects a config still carrying the removed benchtime field', async () => {
    // Vitest exposes no global benchmark-time option, so this field silently
    // did nothing. An existing config must fail loudly rather than quietly
    // stop having an effect.
    await expect(loadConfig(await write('benchtime: 1s\n'))).rejects.toThrow(/unknown setting/)
  })

  it('accepts every documented setting without complaint', async () => {
    const cfg = await loadConfig(
      await write(
        'benchmarks: ["a"]\nscope: ["src/**"]\ncount: 8\nmax_regress_pct: 3\n' +
          'min_effect_pct: 2\ntimeout: 10m\nunfreeze: ["x.test.js"]\nrunner: vitest\nheap_hint: false\n' +
          'gates:\n  lint: "on"\n',
      ),
    )
    expect(cfg.count).toBe(8)
    expect(cfg.gates.lint).toBe('on')
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

  it('refuses a non-integer count', () => {
    expect(() => validate({ ...ok(), count: 4.5 })).toThrow(/at least 4/)
  })

  it('refuses a scope that is not a list of strings', () => {
    expect(() => validate({ ...ok(), scope: 'src/**' })).toThrow(/at least one path pattern/)
    expect(() => validate({ ...ok(), scope: [42] })).toThrow(/empty or whitespace-only/)
  })

  it('refuses benchmarks or unfreeze that are not lists of strings', () => {
    expect(() => validate({ ...ok(), benchmarks: 'parse' })).toThrow(/benchmarks/)
    expect(() => validate({ ...ok(), unfreeze: [7] })).toThrow(/unfreeze/)
  })
})

describe('defaultConfig isolation', () => {
  it('returns a fresh object each call, so callers cannot leak state into each other', () => {
    const a = defaultConfig()
    a.gates.lint = 'off'
    a.scope.push('mutated')
    const b = defaultConfig()
    expect(b.gates.lint).toBe('auto')
    expect(b.scope).toEqual(['**'])
  })
})
