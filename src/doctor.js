/**
 * Checks whether this machine can measure benchmarks reliably.
 *
 * Every check is INFORMATIONAL. Numbers are only as good as the machine
 * producing them, and a thermally throttled laptop on battery produces noise
 * dressed as data — but whether that is acceptable is the human's call, not
 * the harness's, so doctor reports and never blocks.
 */
import { execFile } from 'node:child_process'
import { readFile, stat, statfs } from 'node:fs/promises'
import { cpus, loadavg, platform } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import * as gitx from './gitx.js'
import { vitestBin } from './adapters/bench/vitest.js'

const exec = promisify(execFile)

export const SEVERITY = { OK: 0, WARN: 1, FAIL: 2, NA: -1 }

/** The Node floor: parseArgs, module.register and --heap-prof all need it. */
const MIN_NODE_MAJOR = 20

/**
 * Runs every check. Each one is individually guarded, so an unfamiliar
 * platform or a missing tool degrades one line rather than the whole report.
 *
 * @param {string} dir the repository root, or a directory inside it
 * @returns {Promise<{name: string, detail: string, severity: number}[]>}
 */
export async function check(dir) {
  // `-C` defaults to '.', so every check is given an ABSOLUTE directory once,
  // up front: the git checks shell out with it as cwd, the disk check statfs's
  // it, and the vitest check reports the path it looked in — a relative one
  // would make that message meaningless. Resolving here keeps every check
  // consistent regardless of what the caller passed.
  const absDir = resolvePath(dir)

  const platformCheck =
    platform() === 'darwin' ? ['power', checkDarwin] : platform() === 'linux' ? ['cpu governor', checkLinux] : null

  const checks = [
    ['node', checkNode],
    ['git', checkGit],
    ['git repo', () => checkGitRepo(absDir)],
    ['cpu', checkCpu],
    ['load', checkLoad],
    ['vitest', () => checkVitest(absDir)],
    ['heap hint', checkHeapHint],
    platformCheck,
    ['disk', () => checkDisk(absDir)],
  ].filter(Boolean)

  const findings = []
  for (const [name, fn] of checks) {
    try {
      findings.push(await fn())
    } catch (err) {
      findings.push({ name, detail: `check failed: ${err.message}`, severity: SEVERITY.NA })
    }
  }
  return findings
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  return major >= MIN_NODE_MAJOR
    ? { name: 'node', detail: `node ${process.versions.node}`, severity: SEVERITY.OK }
    : {
        name: 'node',
        detail: `node ${process.versions.node} is too old, need >= ${MIN_NODE_MAJOR}`,
        severity: SEVERITY.FAIL,
      }
}

async function checkGit() {
  try {
    const { stdout } = await exec('git', ['--version'])
    return { name: 'git', detail: stdout.trim(), severity: SEVERITY.OK }
  } catch {
    return { name: 'git', detail: 'git not found on PATH', severity: SEVERITY.FAIL }
  }
}

async function checkGitRepo(dir) {
  try {
    return { name: 'git repo', detail: await gitx.root(dir), severity: SEVERITY.OK }
  } catch {
    return { name: 'git repo', detail: `${dir} is not inside a git repository`, severity: SEVERITY.FAIL }
  }
}

function checkCpu() {
  const n = cpus().length
  return {
    name: 'cpu',
    detail: `${n} logical core(s) — ${cpus()[0]?.model ?? 'unknown model'}`,
    severity: n >= 2 ? SEVERITY.OK : SEVERITY.WARN,
  }
}

function checkLoad() {
  const [one] = loadavg()
  const perCore = one / Math.max(1, cpus().length)
  return {
    name: 'load',
    detail:
      `1-minute load ${one.toFixed(2)} (${perCore.toFixed(2)} per core)` +
      (perCore > 0.5 ? ' — other work on this machine will show up as measurement noise' : ''),
    severity: perCore > 0.5 ? SEVERITY.WARN : SEVERITY.OK,
  }
}

/**
 * Resolves vitest from the MEASURED repository, not this harness's own
 * node_modules — a repo with no vitest installed must not look fine just
 * because the harness happens to depend on it for its own tests.
 */
async function checkVitest(dir) {
  // Check the exact file the adapter spawns, not a module resolution of it.
  // require.resolve('vitest/vitest.mjs') honours the package `exports` map,
  // and Vitest 2 exposes a `./*` wildcard there while Vitest 3 and 4 do not —
  // so the resolution answered "not installed" for every Vitest 3/4 repository
  // even though the file is present and benchmarks measure fine. doctor exists
  // to predict whether measurement will work, so it must ask what measurement
  // asks.
  const bin = vitestBin(dir)
  const present = await stat(bin).then(
    (st) => st.isFile(),
    () => false,
  )
  return present
    ? { name: 'vitest', detail: 'vitest resolves in this repository', severity: SEVERITY.OK }
    : {
        name: 'vitest',
        detail: `vitest is not installed here — benchmarks cannot be measured until it is (looked for ${bin})`,
        severity: SEVERITY.WARN,
      }
}

function checkHeapHint() {
  // Reported up front so a run does not discover mid-flight that the hint is
  // unavailable, which would otherwise look like the benchmark allocating
  // nothing. The driver always spawns its own child with --expose-gc, so
  // this is OK regardless of whether gc() happens to be exposed in THIS
  // process — but say so explicitly rather than implying it was probed here.
  return {
    name: 'heap hint',
    detail: 'the driver spawns its own --expose-gc child, so the bytes/op hint should be available',
    severity: SEVERITY.OK,
  }
}

/**
 * Runs a command and returns its trimmed stdout, or null if it failed —
 * missing binary, non-zero exit, or unrecognized flag. Every macOS-specific
 * probe below tolerates null so one absent tool degrades one note, not the
 * whole finding.
 */
async function tryExec(cmd, args) {
  try {
    const { stdout } = await exec(cmd, args)
    return stdout
  } catch {
    return null
  }
}

async function checkDarwin() {
  const notes = []
  let severity = SEVERITY.OK

  const batt = await tryExec('pmset', ['-g', 'batt'])
  if (batt === null) {
    notes.push('pmset unavailable — power source unknown')
  } else if (/Battery Power/.test(batt)) {
    notes.push('running on battery — macOS clocks down aggressively')
    severity = SEVERITY.WARN
  } else {
    notes.push('on AC power')
  }

  const gen = await tryExec('pmset', ['-g'])
  if (gen === null) {
    notes.push('Low Power Mode unknown')
  } else {
    const m = gen.match(/lowpowermode\s+(\d+)/i)
    if (m && m[1] !== '0') {
      notes.push('Low Power Mode is on')
      severity = SEVERITY.WARN
    }
  }

  // `machdep.xcpm.cpu_thermal_level` is Intel-only (xcpm = Intel's power
  // manager) and does not exist on Apple Silicon, where sysctl exits
  // non-zero with "unknown oid". `pmset -g therm` works on both, but macOS
  // only starts recording these fields once a thermal EVENT has actually
  // occurred since boot — a fresh boot legitimately prints
  // "No thermal warning level has been recorded", which means "nothing to
  // report", not "unknown". Anything else unrecognized is reported as such
  // rather than silently assumed fine.
  const therm = await tryExec('pmset', ['-g', 'therm'])
  if (therm === null) {
    notes.push('thermal state unknown (pmset -g therm unavailable)')
  } else {
    const limit = therm.match(/CPU_Speed_Limit\s*=\s*(\d+)/)
    if (limit) {
      const pct = Number(limit[1])
      if (pct < 100) {
        notes.push(`CPU speed limited to ${pct}% by thermal pressure`)
        severity = SEVERITY.WARN
      } else {
        notes.push('no thermal throttling')
      }
    } else if (/No thermal warning level has been recorded/i.test(therm)) {
      notes.push('no thermal event recorded since boot')
    } else {
      notes.push('thermal state format not recognized on this machine')
    }
  }

  notes.push('P/E core scheduling makes macOS numbers jump; a quiet Linux box gives cleaner results')
  return { name: 'power', detail: notes.join('; '), severity }
}

async function checkLinux() {
  const governor = await readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').catch(() => null)
  const noTurbo = await readFile('/sys/devices/system/cpu/intel_pstate/no_turbo', 'utf8').catch(() => null)
  const notes = []
  let severity = SEVERITY.OK
  if (governor === null) {
    notes.push('cpufreq governor not readable')
  } else if (governor.trim() !== 'performance') {
    notes.push(`cpufreq governor is "${governor.trim()}" — "performance" gives steadier numbers`)
    severity = SEVERITY.WARN
  } else {
    notes.push('cpufreq governor is "performance"')
  }
  if (noTurbo !== null && noTurbo.trim() === '0') {
    notes.push('turbo boost is enabled — clock varies with temperature')
    severity = SEVERITY.WARN
  }
  return { name: 'cpu governor', detail: notes.join('; '), severity }
}

async function checkDisk(dir) {
  const stats = await statfs(dir)
  const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3
  return {
    name: 'disk',
    detail: `${freeGb.toFixed(1)} GB free`,
    severity: freeGb < 2 ? SEVERITY.WARN : SEVERITY.OK,
  }
}
