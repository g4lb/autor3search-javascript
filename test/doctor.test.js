import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SEVERITY, check } from '../src/doctor.js'
import { runCli } from './helpers/cli.js'
import { makeBenchRepo } from './helpers/bench-repo.js'
import { makeRepo } from './helpers/repo.js'

const named = (findings, name) => findings.find((f) => f.name === name)

describe('check', () => {
  it('reports the node version as OK on a supported runtime', async () => {
    const f = named(await check(await makeRepo()), 'node')
    expect(f.severity).toBe(SEVERITY.OK)
    expect(f.detail).toContain(process.versions.node)
  })

  it('reports git and that the directory is a repository', async () => {
    const findings = await check(await makeRepo())
    expect(named(findings, 'git').severity).toBe(SEVERITY.OK)
    expect(named(findings, 'git repo').severity).toBe(SEVERITY.OK)
  })

  it('flags a directory that is not a git repository', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'a3s-nogit-'))
    expect(named(await check(dir), 'git repo').severity).toBe(SEVERITY.FAIL)
  })

  it('reports the cpu count and load average', async () => {
    const findings = await check(await makeRepo())
    expect(named(findings, 'cpu').detail).toMatch(/\d+ logical/)
    expect(named(findings, 'load').detail).toMatch(/\d/)
  })

  it('reports free disk space', async () => {
    expect(named(await check(await makeRepo()), 'disk').detail).toMatch(/GB free/)
  })

  it('flags a repository with no vitest installed', async () => {
    expect(named(await check(await makeRepo()), 'vitest').severity).toBe(SEVERITY.WARN)
  })

  it('reports vitest as OK when the repository has it', async () => {
    expect(named(await check(await makeBenchRepo()), 'vitest').severity).toBe(SEVERITY.OK)
  })

  it('reports whether the heap hint will be available', async () => {
    const f = named(await check(await makeRepo()), 'heap hint')
    expect([SEVERITY.OK, SEVERITY.WARN]).toContain(f.severity)
  })

  it('includes a platform-specific check on macOS and Linux', async () => {
    const findings = await check(await makeRepo())
    if (process.platform === 'darwin') expect(named(findings, 'power')).toBeTruthy()
    if (process.platform === 'linux') expect(named(findings, 'cpu governor')).toBeTruthy()
  })

  it('never throws on a platform it does not know', async () => {
    await expect(check(await makeRepo())).resolves.toBeInstanceOf(Array)
  })

  it('reports vitest correctly when -C is a relative path', async () => {
    // `-C` defaults to "." and createRequire throws on relative paths, which
    // silently reported "vitest not installed" for every repo that had it.
    const dir = await makeBenchRepo()
    const relativeDir = relative(process.cwd(), dir)
    const findings = await check(relativeDir)
    const vitest = findings.find((f) => f.name === 'vitest')
    expect(vitest.severity).toBe(SEVERITY.OK)
  })
})

describe('doctor command', () => {
  it('always exits 0, even with findings', async () => {
    expect((await runCli(['doctor', '-C', await makeRepo()])).code).toBe(0)
  })

  it('marks each finding with a legible severity', async () => {
    const { out } = await runCli(['doctor', '-C', await makeRepo()])
    expect(out).toMatch(/\b(ok|warn|fail|n\/a)\b/i)
  })

  it('summarises whether the machine looks fit to measure', async () => {
    const { out } = await runCli(['doctor', '-C', await makeBenchRepo()])
    expect(out).toMatch(/fit to measure|warning|problem/i)
  })
})
