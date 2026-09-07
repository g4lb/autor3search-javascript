/**
 * Drives bench files outside Vitest, for the two things Vitest's benchmark
 * reporter cannot give us: an allocation hint, and a CPU/heap profile.
 *
 * Everything here is BEST-EFFORT. V8 has no allocation counter, the sampling
 * window is at the mercy of GC scheduling, and a bench file may do something
 * the shim cannot drive. Any failure yields an empty set and a note in the
 * log — never an exception that would sink an otherwise-valid experiment.
 * src/pipeline.js relies on that: a missing hint must not cost a KEEP.
 */
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BenchSet, UNIT_BYTES } from '../bench/set.js'
import { Runner } from '../runner.js'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'driver-child.js')

/**
 * Lists the benchmarks a bench file registers, without measuring anything.
 *
 * @param {string} benchFile absolute path
 * @returns {Promise<{name: string, path: string}[]>}
 */
export async function collectTasks(benchFile) {
  const payload = await invoke(dirname(benchFile), 'list', {
    benchFiles: [benchFile],
    benchmarks: [],
    iterations: 0,
  })
  return (payload?.tasks ?? []).map(({ name, path }) => ({ name, path }))
}

/**
 * Measures the approximate bytes allocated per operation, one observation per
 * benchmark. Returns an EMPTY set when the measurement is unavailable.
 *
 * @param {string} dir the worktree to measure
 * @param {{benchFiles: string[], benchmarks?: string[], iterations: number, timeoutMs: number, env?: object, log?: {write(s: string): void}}} opts
 * @returns {Promise<BenchSet>}
 */
export async function measureHeap(dir, opts) {
  const set = new BenchSet()
  let payload
  try {
    payload = await invoke(dir, 'heap', {
      benchFiles: opts.benchFiles.map((f) => resolvePath(dir, f)),
      benchmarks: opts.benchmarks ?? [],
      iterations: opts.iterations ?? 1000,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      execArgv: ['--expose-gc'],
    })
  } catch (err) {
    opts.log?.write(`heap hint unavailable, continuing without it: ${err.message}\n`)
    return set
  }
  if (payload?.error) {
    opts.log?.write(`heap hint unavailable, continuing without it: ${payload.error}\n`)
    return set
  }
  if (payload?.gcAvailable === false) {
    opts.log?.write('heap hint unavailable: node was not started with --expose-gc\n')
    return set
  }
  for (const r of payload?.results ?? []) {
    if (r.bytesPerOp === null) continue
    set.record(`${r.file} > ${r.path}`, r.name, UNIT_BYTES, r.bytesPerOp)
  }
  return set
}

/**
 * Runs the benchmarks under V8's CPU and heap profilers, writing the raw
 * profiles into outDir. Both files are openable in Chrome DevTools or
 * speedscope; src/profile.js summarises the CPU one.
 *
 * @returns {Promise<{cpuProfile: string, heapProfile: string}>}
 */
export async function runProfiled(dir, opts) {
  await mkdir(opts.outDir, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'a3s-prof-'))
  try {
    await invoke(dir, 'heap', {
      benchFiles: opts.benchFiles.map((f) => resolvePath(dir, f)),
      benchmarks: opts.benchmarks ?? [],
      iterations: opts.iterations ?? 1000,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      execArgv: [
        '--expose-gc',
        '--cpu-prof',
        `--cpu-prof-dir=${scratch}`,
        '--heap-prof',
        `--heap-prof-dir=${scratch}`,
      ],
    })
    // V8 names the profiles after a timestamp and the pid; rename them to
    // stable paths so `profile` can print a filename a human can act on.
    const written = await readdir(scratch)
    const out = { cpuProfile: join(opts.outDir, 'cpu.cpuprofile'), heapProfile: join(opts.outDir, 'heap.heapprofile') }
    for (const name of written) {
      if (name.endsWith('.cpuprofile')) await rename(join(scratch, name), out.cpuProfile)
      else if (name.endsWith('.heapprofile')) await rename(join(scratch, name), out.heapProfile)
    }
    return out
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Spawns the driver child and parses its single JSON object. */
async function invoke(dir, mode, options) {
  const scratch = await mkdtemp(join(tmpdir(), 'a3s-driver-'))
  const optionsPath = join(scratch, 'options.json')
  try {
    await writeFile(optionsPath, JSON.stringify(options))
    const runner = new Runner(dir, options.timeoutMs ?? 120_000, null)
    const result = await runner.run(
      process.execPath,
      [...(options.execArgv ?? []), CHILD, mode, optionsPath],
      { env: options.env ?? process.env },
    )
    if (result.stdout.trim() === '') {
      throw new Error(`driver produced no output (exit ${result.exitCode}):\n${result.tail(20)}`)
    }
    return JSON.parse(result.stdout)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
