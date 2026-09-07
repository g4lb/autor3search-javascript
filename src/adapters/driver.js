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
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
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
    // Key on a path RELATIVE to `dir`, never the absolute one. `dir` is the
    // pinned baseline worktree for one side and the repository root for the
    // other, so absolute keys can never match across the two and every
    // cross-directory comparison silently produced no hint at all. The time
    // path avoids this only because Vitest's own report yields root-relative
    // names — see taskPath in src/bench/parse.js — so this mirrors it.
    set.record(`${relative(dir, r.file)} > ${r.path}`, r.name, UNIT_BYTES, r.bytesPerOp)
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
    // V8 names the profiles after a timestamp and pid — verified on Node
    // 22.23.1 as `CPU.<timestamp>.<pid>.0.001.cpuprofile` and
    // `Heap.<timestamp>.<pid>.0.002.heapprofile`. There is NO fixed filename to
    // predict, so they are matched by extension.
    //
    // CRUCIALLY, there is more than one of each. `module.register` runs the
    // resolve hooks on their own thread, and --cpu-prof/--heap-prof profile
    // that thread too — so a run yields both the MAIN thread's profile (the
    // benchmark frames we want) and the LOADER thread's (module-resolution
    // internals, no user code at all). Taking whichever readdir happened to
    // return last picked the loader's profile in 3 of 3 trials, handing back a
    // perfectly valid, non-empty profile containing ZERO frames of the
    // benchmarked code.
    //
    // Content-based heuristics were tried and rejected: CPU sample count
    // discriminated correctly in every trial run during verification, but the
    // equivalent heap "most tree nodes" heuristic FLIPPED between trials (the
    // main thread's heap-prof tree was sometimes smaller than the loader
    // thread's, since heap-prof sampling is allocation-triggered and its yield
    // is luck-of-the-draw, not proportional to "is this the thread that ran
    // the benchmark"). So instead this parses the filename's thread-id field:
    // Node names each profile `<Kind>.<date>.<time>.<pid>.<threadId>.<seq>.<ext>`,
    // and the main thread's threadId is always 0 — a structural guarantee
    // (`node:worker_threads` documents `threadId === 0` off the main thread),
    // not an empirical proxy. Verified across 5 trials: the threadId-0 file is
    // the one containing `driver-child.js`/benchmark frames in every case.
    const written = await readdir(scratch)
    const out = { cpuProfile: join(opts.outDir, 'cpu.cpuprofile'), heapProfile: join(opts.outDir, 'heap.heapprofile') }
    const cpu = mainThreadFile(written, '.cpuprofile')
    const heap = mainThreadFile(written, '.heapprofile')
    if (cpu) await rename(join(scratch, cpu), out.cpuProfile)
    if (heap) await rename(join(scratch, heap), out.heapProfile)
    return out
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Of several profile files V8 wrote for one run, picks the one written by the
 * MAIN thread — see the long comment in runProfiled for why this can't be a
 * content heuristic. Falls back to the alphabetically-first file (still
 * deterministic) on the Node versions this was verified against, every
 * profile filename carries the thread-id field, so the fallback is not
 * expected to trigger in practice.
 */
function mainThreadFile(names, extension) {
  const candidates = names
    .filter((n) => n.endsWith(extension))
    .map((n) => ({ name: n, threadId: n.split('.').at(-3) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (candidates.find((c) => c.threadId === '0') ?? candidates[0])?.name ?? null
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
