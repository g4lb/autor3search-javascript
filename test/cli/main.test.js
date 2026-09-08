import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXIT_USAGE } from '../../src/cli/main.js'
import { runCli } from '../helpers/cli.js'
import { makeRepo } from '../helpers/repo.js'

describe('dispatch', () => {
  it('prints usage and the usage exit code with no arguments', async () => {
    const { code, err } = await runCli([])
    expect(code).toBe(EXIT_USAGE)
    expect(err).toMatch(/usage: autor3search-javascript <command>/)
  })

  it('lists every command in usage', async () => {
    const { err } = await runCli([])
    for (const name of ['init', 'doctor', 'baseline', 'profile', 'eval', 'status', 'stop', 'report', 'version']) {
      expect(err).toContain(name)
    }
  })

  it('names an unknown command', async () => {
    const { code, err } = await runCli(['frobnicate'])
    expect(code).toBe(EXIT_USAGE)
    expect(err).toMatch(/unknown command "frobnicate"/)
  })

  it('rejects an unknown flag with the usage code, not a stack trace', async () => {
    const { code, err } = await runCli(['version', '--nope'])
    expect(code).toBe(EXIT_USAGE)
    expect(err).not.toMatch(/at Object\./)
  })
})

describe('version', () => {
  it('prints the package version', async () => {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    const { code, out } = await runCli(['version'])
    expect(code).toBe(0)
    expect(out).toContain(pkg.version)
  })

  it('names the harness so a results.tsv row can be traced to a build', async () => {
    const { out } = await runCli(['version'])
    expect(out).toContain('autor3search-javascript')
  })

  it('reports the commit when running from a git checkout', async () => {
    const { out } = await runCli(['version'])
    expect(out).toMatch(/(commit [0-9a-f]{7}|not a git checkout)/)
  })

  it('accepts -C without changing the process working directory', async () => {
    const dir = await makeRepo()
    const before = process.cwd()
    const { code } = await runCli(['version', '-C', dir])
    expect(code).toBe(0)
    expect(process.cwd()).toBe(before)
  })
})
