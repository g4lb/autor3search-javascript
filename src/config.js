/**
 * Loads and validates the autor3search-javascript run configuration.
 *
 * The file lives inside the repository because humans own it and want it in
 * version control. That means the agent can reach it, so it is protected by
 * integrity checking rather than relocation: `baseline` records its hash and
 * `eval` fails the run if it has changed. See src/pipeline.js.
 */
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { isIterationCountForm, parseDuration } from './duration.js'

/** Config location, relative to the repository root. */
export const CONFIG_PATH = '.autor3search/config.yaml'

/** The only bench runner adapter registered in this version. */
export const RUNNERS = ['vitest']

/** Permitted values for each entry under `gates:`. */
export const GATE_MODES = ['auto', 'on', 'off']

/**
 * The smallest `count` at which the exact Mann-Whitney test used by
 * src/bench/stats.js can ever report p < 0.05, however large or clean the
 * improvement is. At 2 and 3 rounds per side the best achievable two-sided
 * p-value is 0.3333 and 0.1 — both above the default alpha — so every single
 * experiment would be discarded on a technicality rather than on its merits,
 * with nothing in the output explaining why.
 */
export const MIN_COUNT = 4

/** Returns the configuration used when a field is omitted. */
export function defaultConfig() {
  return {
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
  }
}

/** YAML key -> in-memory field. Keys absent here keep their own name. */
const KEY_MAP = {
  max_regress_pct: 'maxRegressPct',
  min_effect_pct: 'minEffectPct',
  heap_hint: 'heapHint',
}

/** Every in-memory field name, derived from the defaults so the two cannot drift. */
const KNOWN_FIELDS = new Set(Object.keys(defaultConfig()))

/** Every key a user may legally write in the YAML, for the error message. */
const KNOWN_YAML_KEYS = new Set([
  ...Object.keys(KEY_MAP),
  ...[...KNOWN_FIELDS].filter((f) => !Object.values(KEY_MAP).includes(f)),
])

/**
 * Reads a config file, applying defaults for omitted fields and validating
 * the result.
 *
 * @param {string} path
 * @returns {Promise<object>}
 */
export async function loadConfig(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`read config ${path}: ${err.message}`, { cause: err })
  }

  let raw
  try {
    raw = parseYaml(text) ?? {}
  } catch (err) {
    throw new Error(`parse ${path}: ${err.message}`, { cause: err })
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`parse ${path}: expected a mapping of settings at the top level`)
  }

  const cfg = defaultConfig()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    const field = KEY_MAP[key] ?? key
    // An unrecognised key is an ERROR, never a stray property. Without this, a
    // typo like `max_regres_pct` is silently accepted while the real field
    // keeps its default — so the run gates on a threshold the user never set
    // and nothing says so. config.yaml is hashed at baseline, which means that
    // typo is then locked in for the entire run.
    if (!KNOWN_FIELDS.has(field)) {
      throw new Error(
        `${path}: unknown setting ${JSON.stringify(key)} — known settings are: ${[...KNOWN_YAML_KEYS].sort().join(', ')}`,
      )
    }
    // `gates` merges rather than replaces, so a config setting one gate does
    // not silently drop the defaults for the other two.
    if (field === 'gates' && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(cfg.gates, value)
      continue
    }
    cfg[field] = value
  }

  try {
    validate(cfg)
  } catch (err) {
    throw new Error(`invalid ${path}: ${err.message}`, { cause: err })
  }
  return cfg
}

/**
 * Reports whether the configuration is usable, throwing an Error whose
 * message explains the problem in terms of what it would do to a run.
 *
 * @param {object} c
 * @throws {Error}
 */
export function validate(c) {
  if (!Number.isInteger(c.count) || c.count < MIN_COUNT) {
    throw new Error(
      `count must be at least ${MIN_COUNT}: the significance test cannot report p < 0.05 with fewer ` +
        `than ${MIN_COUNT} measured rounds per side no matter how large the improvement is, so every ` +
        `experiment would be discarded regardless of what changed (the default is 10)`,
    )
  }
  if (typeof c.maxRegressPct !== 'number' || c.maxRegressPct < 0) {
    throw new Error('max_regress_pct must not be negative')
  }
  if (typeof c.minEffectPct !== 'number' || c.minEffectPct < 0 || c.minEffectPct >= 100) {
    throw new Error('min_effect_pct must be at least 0 and less than 100')
  }
  if (!Array.isArray(c.scope) || c.scope.length === 0) {
    throw new Error('scope must list at least one path pattern')
  }
  for (const s of c.scope) {
    if (typeof s !== 'string' || s.trim() === '') {
      throw new Error('scope must not contain an empty or whitespace-only entry')
    }
  }
  if (!Array.isArray(c.unfreeze) || c.unfreeze.some((u) => typeof u !== 'string')) {
    throw new Error('unfreeze must be a list of file paths')
  }
  if (!Array.isArray(c.benchmarks) || c.benchmarks.some((b) => typeof b !== 'string')) {
    throw new Error('benchmarks must be a list of benchmark names')
  }

  try {
    parseDuration(c.benchtime)
  } catch (err) {
    if (isIterationCountForm(c.benchtime)) {
      throw new Error(
        `benchtime ${JSON.stringify(c.benchtime)} uses the fixed-iteration-count form (Nx), which is ` +
          `deliberately unsupported here: a fixed count makes rounds incomparable, because a candidate ` +
          `that is twice as fast finishes in half the wall time and is therefore measured under ` +
          `different thermal conditions — exactly what the interleaved A/B design exists to eliminate. ` +
          `Use a duration instead, e.g. benchtime: 1s`,
      )
    }
    throw err
  }
  parseDuration(c.timeout)

  if (!RUNNERS.includes(c.runner)) {
    throw new Error(
      `runner ${JSON.stringify(c.runner)} is not a registered bench adapter (have: ${RUNNERS.join(', ')})`,
    )
  }
  if (typeof c.heapHint !== 'boolean') {
    throw new Error('heap_hint must be true or false')
  }
  for (const name of ['typecheck', 'lint', 'test']) {
    if (!GATE_MODES.includes(c.gates?.[name])) {
      throw new Error(`gates.${name} must be one of ${GATE_MODES.join(', ')}`)
    }
  }
}
