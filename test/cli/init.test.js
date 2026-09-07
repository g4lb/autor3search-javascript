import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { runCli } from '../helpers/cli.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'
import { makeRepo, writeFiles } from '../helpers/repo.js'

const read = (dir, rel) => readFile(join(dir, rel), 'utf8')

describe('init', () => {
  it('writes the config, program.md and gitignore entries', async () => {
    const dir = await makeBenchRepo()
    const { code, out } = await runCli(['init', '-C', dir])
    expect(code).toBe(0)
    await expect(stat(join(dir, '.autor3search/config.yaml'))).resolves.toBeTruthy()
    await expect(stat(join(dir, 'program.md'))).resolves.toBeTruthy()
    expect(out).toMatch(/countWords/)
  })

  it('records the discovered benchmarks in the config', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    expect(parseYaml(await read(dir, '.autor3search/config.yaml')).benchmarks).toEqual(['countWords'])
  })

  it('writes a config that loads and validates', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    const { loadConfig } = await import('../../src/config.js')
    await expect(loadConfig(join(dir, '.autor3search/config.yaml'))).resolves.toBeTruthy()
  })

  it('gitignores the harness outputs but not the config', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    const ignore = await read(dir, '.gitignore')
    expect(ignore).toContain('results.tsv')
    expect(ignore).toContain('run.log')
    expect(ignore).toContain('.autor3search/*')
    expect(ignore).toContain('!.autor3search/config.yaml')
  })

  it('does not duplicate gitignore entries on a second run', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    await runCli(['init', '-C', dir, '--force'])
    const ignore = await read(dir, '.gitignore')
    expect(ignore.split('\n').filter((l) => l === 'run.log')).toHaveLength(1)
  })

  it('refuses to overwrite an existing config without --force', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    const { code, err } = await runCli(['init', '-C', dir])
    expect(code).not.toBe(0)
    expect(err).toMatch(/--force/)
  })

  it('overwrites with --force', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    expect((await runCli(['init', '-C', dir, '--force'])).code).toBe(0)
  })

  it('refuses a repository with no benchmarks, and says why', async () => {
    const dir = await makeRepo({ 'src/a.js': 'export const a = 1\n' })
    const { code, err } = await runCli(['init', '-C', dir])
    expect(code).not.toBe(0)
    expect(err).toMatch(/no benchmarks/i)
    expect(err).toMatch(/bench\(/)
    await expect(stat(join(dir, '.autor3search/config.yaml'))).rejects.toThrow()
  })

  it('commits nothing', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    const { isClean } = await import('../../src/gitx.js')
    expect(await isClean(dir)).toBe(false)
  })

  it('writes a program.md naming this harness and the frozen bench files', async () => {
    const dir = await makeBenchRepo()
    await runCli(['init', '-C', dir])
    const program = await read(dir, 'program.md')
    expect(program).toContain('autor3search-javascript eval')
    expect(program).toMatch(/\*\.bench\./)
    expect(program).toContain('package.json')
  })

  it('reports each discovered benchmark and its file', async () => {
    const dir = await makeBenchRepo()
    await writeFiles(dir, {
      'src/extra.bench.js': `import { bench } from 'vitest'\nbench('extra', () => {})\n`,
    })
    const { out } = await runCli(['init', '-C', dir])
    expect(out).toContain('src/extra.bench.js')
    expect(out).toContain('extra')
  })
})
