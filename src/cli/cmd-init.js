/**
 * Scans the repository, discovers benchmarks, and writes the run
 * configuration and the agent's instruction set.
 *
 * It writes files and commits NOTHING. `baseline` refuses an uncommitted
 * tree, so the human commits what init produced — deliberately, because a
 * baseline pinned against what is on disk rather than what is in git would
 * not be reproducible.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CONFIG_PATH, defaultConfig } from '../config.js'
import { baseNames, benchmarks } from '../discover.js'
import { resolveRepo } from './context.js'

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'program.md')

/** Entries init adds to .gitignore, in order. */
const IGNORE_ENTRIES = ['results.tsv', 'run.log', '.autor3search/*', '!.autor3search/config.yaml']

export async function runInit(args, io) {
  const { values } = parseArgs({
    args,
    options: { C: { type: 'string', default: '.' }, force: { type: 'boolean', default: false } },
    allowPositionals: false,
  })
  const root = await resolveRepo(values.C)

  const found = await benchmarks(root)
  if (found.length === 0) {
    // Refusing is deliberate. The verdict is entirely a function of the
    // declared benchmarks' timings, so with none there is no signal to gate
    // on — every candidate would be accepted or rejected for no reason.
    io.err.write(
      `no benchmarks found in ${root}.\n\n` +
        `autor3search-javascript optimizes what it can measure, and refuses to guess. Write at least one\n` +
        `Vitest benchmark covering the code you want made faster, in a *.bench.js file:\n\n` +
        `    import { bench } from 'vitest'\n` +
        `    import { thing } from './thing.js'\n\n` +
        `    bench('thing', () => { thing() })\n\n` +
        `Benchmark the path that actually dominates your workload — one that exercises a cold path or a\n` +
        `trivial helper produces numbers that are entirely real and entirely useless. Then run init again.\n`,
    )
    return 2
  }

  const configPath = join(root, CONFIG_PATH)
  const exists = await stat(configPath).then(
    () => true,
    () => false,
  )
  if (exists && !values.force) {
    io.err.write(`${CONFIG_PATH} already exists; pass --force to overwrite it\n`)
    return 2
  }

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, renderConfig(baseNames(found)))
  await copyFile(TEMPLATE, join(root, 'program.md'))
  await addIgnoreEntries(join(root, '.gitignore'))

  io.out.write(`discovered ${found.length} benchmark(s):\n`)
  for (const b of found) io.out.write(`  ${b.path.padEnd(40)} ${b.file}\n`)
  io.out.write(`\nwrote ${CONFIG_PATH}, program.md and .gitignore entries.\n`)
  io.out.write(`next: git add -A && git commit -m "autor3search-javascript init"\n`)
  io.out.write(`then: autor3search-javascript doctor && autor3search-javascript baseline -tag <tag>\n`)
  return 0
}

/**
 * Renders the config as commented YAML rather than serialising the defaults
 * object: the comments are the documentation a human reads when deciding
 * what to change, and they are the reason this file lives in the repository
 * at all.
 */
function renderConfig(names) {
  const d = defaultConfig()
  return `# autor3search-javascript run configuration.
#
# This file is HUMAN-OWNED and version-controlled. Its hash is recorded at
# baseline time, so any change during a run fails the run rather than
# silently moving the goalposts.

# The declared benchmark set. An empty list means every discovered benchmark.
benchmarks:
${names.map((n) => `  - ${JSON.stringify(n)}`).join('\n')}

# Glob patterns the agent may edit. Everything else is rejected before an
# experiment is even measured.
scope:
  - "**"

# Measured rounds per side. Below 4 the significance test can never report
# p < 0.05 however large the improvement, so every experiment would discard.
count: ${d.count}

# The largest tolerated significant regression, in percent.
max_regress_pct: ${d.maxRegressPct}

# The smallest geomean improvement a KEEP will accept, in percent.
min_effect_pct: ${d.minEffectPct}

# Bound on each subprocess phase.
timeout: ${d.timeout}

# Test or bench files deliberately exempt from freezing.
unfreeze: []

# The bench adapter. Only "vitest" is registered in this version.
runner: ${d.runner}

# Sample approximate bytes/op alongside the timings. Never scored.
heap_hint: ${d.heapHint}

# auto runs each gate when the repository is set up for it, on requires it,
# off never runs it.
gates:
  typecheck: ${d.gates.typecheck}
  lint: ${d.gates.lint}
  test: ${d.gates.test}
`
}

/** Appends any missing ignore entries, leaving existing content untouched. */
async function addIgnoreEntries(path) {
  const existing = await readFile(path, 'utf8').catch(() => '')
  const lines = new Set(existing.split('\n').map((l) => l.trim()))
  const missing = IGNORE_ENTRIES.filter((entry) => !lines.has(entry))
  if (missing.length === 0) return
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await writeFile(path, `${existing}${prefix}\n# autor3search-javascript\n${missing.join('\n')}\n`)
}
