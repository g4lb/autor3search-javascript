/**
 * Runs the declared benchmarks under V8's CPU and heap profilers and reports
 * the hot spots.
 *
 * The point is to give an agent real data on where time actually goes, rather
 * than have it guess from reading source. A .cpuprofile is a documented V8
 * JSON structure, so the hot-spot table is computed here directly — no pprof
 * equivalent is needed — and the raw files stay on disk for a human to open.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runProfiled } from './adapters/driver.js'
import { benchFiles } from './discover.js'
import { parseDuration } from './duration.js'

/** Where profiles are written, relative to the repository root. */
export const PROFILE_DIR = '.autor3search/profiles'

/** V8's synthetic frames: never code an agent can optimize. */
const SYNTHETIC = new Set(['(root)', '(program)', '(idle)', '(garbage collector)'])

/**
 * The functions with the most self time in a .cpuprofile.
 *
 * Self time is what matters for optimization: a function high in total time
 * may simply be a caller of the real hot spot. Self time per node is the sum
 * of the timeDeltas (microseconds) attributed to the samples that name it —
 * `samples` and `timeDeltas` are parallel arrays, each samples[i] a node id
 * and timeDeltas[i] the microseconds charged to it.
 *
 * @param {object} cpuProfile parsed .cpuprofile JSON
 * @param {number} limit
 * @returns {{name: string, file: string, selfMs: number, pct: number}[]}
 */
export function topFunctions(cpuProfile, limit) {
  const byId = new Map((cpuProfile.nodes ?? []).map((n) => [n.id, n]))
  const selfMicros = new Map()

  const samples = cpuProfile.samples ?? []
  const deltas = cpuProfile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (deltas[i] ?? 0))
  }

  const entries = [...selfMicros.entries()]
    .map(([id, micros]) => {
      const frame = byId.get(id)?.callFrame ?? {}
      return {
        name: frame.functionName || '(anonymous)',
        file: frame.url ? basename(frame.url) : '',
        selfMs: micros / 1000,
        micros,
      }
    })
    .filter((entry) => !SYNTHETIC.has(entry.name))

  const total = entries.reduce((a, e) => a + e.micros, 0)
  if (total === 0) return []

  return entries
    .map(({ micros, ...rest }) => ({ ...rest, pct: (micros / total) * 100 }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit)
}

/**
 * Profiles each bench file in turn, one output directory per file.
 *
 * One directory per file rather than one combined profile, because a merged
 * profile cannot say which benchmark a hot function belongs to — which is the
 * question the agent is asking.
 *
 * @param {string} root
 * @param {object} cfg loaded run configuration
 * @param {{iterations?: number, top?: number}} [opts]
 * @returns {Promise<{file: string, cpuProfile: string, heapProfile: string, top: object[]}[]>}
 */
export async function profile(root, cfg, opts = {}) {
  const files = await benchFiles(root)
  if (files.length === 0) throw new Error(`no *.bench.* files found in ${root}`)

  const reports = []
  for (const file of files) {
    const outDir = join(root, PROFILE_DIR, basename(file).replace(/\.bench\.[^.]+$/, ''))
    const written = await runProfiled(root, {
      benchFiles: [file],
      benchmarks: cfg.benchmarks,
      outDir,
      iterations: opts.iterations ?? 2000,
      timeoutMs: parseDuration(cfg.timeout),
    })
    let cpu = {}
    if (written.cpuProfile) {
      cpu = JSON.parse(await readFile(written.cpuProfile, 'utf8').catch(() => '{}'))
    }
    reports.push({ file, ...written, top: topFunctions(cpu, opts.top ?? 15) })
  }
  return reports
}
