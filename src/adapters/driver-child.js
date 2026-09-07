/**
 * The child process the driver spawns.
 *
 * Invoked as:
 *   node [--expose-gc] driver-child.js <mode> <jsonOptionsPath>
 * where mode is "list", "heap" or "profile". It prints ONE JSON object to
 * stdout and nothing else, so the parent never has to parse around noise.
 */
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

const [, , mode, optionsPath] = process.argv

async function main() {
  register('./driver-hooks.js', import.meta.url)
  const options = JSON.parse(await readFile(optionsPath, 'utf8'))

  const tasks = []
  for (const file of options.benchFiles) {
    globalThis.__a3sTasks = []
    globalThis.__a3sSuite = []
    await import(pathToFileURL(file).href)
    for (const task of globalThis.__a3sTasks) tasks.push({ ...task, file })
  }

  // Selection is by NAME, matching how the rest of the harness selects (see
  // BenchSet.selectByBase). An empty list selects everything. Deliberately not
  // a regexp: a hand-edited config name containing a metacharacter must never
  // silently widen what gets measured.
  const wanted = new Set(options.benchmarks ?? [])
  const selected = wanted.size === 0 ? tasks : tasks.filter((t) => wanted.has(t.name))

  if (mode === 'list') {
    return { tasks: selected.map(({ name, path, file }) => ({ name, path, file })) }
  }

  const results = []
  for (const task of selected) {
    // A short warmup lets V8 tier the function up, so the measured window
    // reflects steady-state allocation rather than first-call overhead.
    for (let i = 0; i < Math.min(50, options.iterations); i++) await task.fn()

    globalThis.gc?.()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < options.iterations; i++) await task.fn()
    // Deliberately NOT collecting here: a collection would discard exactly the
    // allocations being counted. The cost is that a collection running INSIDE
    // the loop shows up as a negative delta, which is reported as no
    // observation rather than as a negative allocation figure.
    const after = process.memoryUsage().heapUsed

    const delta = after - before
    results.push({
      name: task.name,
      path: task.path,
      file: task.file,
      bytesPerOp: delta > 0 ? delta / options.iterations : null,
    })
  }
  return { results, gcAvailable: typeof globalThis.gc === 'function' }
}

main().then(
  (payload) => {
    process.stdout.write(JSON.stringify(payload))
  },
  (err) => {
    process.stdout.write(JSON.stringify({ error: err?.stack ?? String(err) }))
    process.exitCode = 1
  },
)
