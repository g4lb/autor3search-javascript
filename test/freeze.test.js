import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ERR_STORE_TAMPERED, ERR_SYMLINK, loadManifest, restore, saveManifest, snapshot, verify } from '../src/freeze.js'
import { writeFiles } from './helpers/repo.js'

let repo, store
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'a3s-freeze-'))
  repo = join(base, 'repo')
  store = join(base, 'state', 'frozen')
  await mkdir(repo, { recursive: true })
})

const seed = () => writeFiles(repo, { 'src/a.test.js': 'original a\n', 'src/b.bench.js': 'original b\n' })
const files = ['src/a.test.js', 'src/b.bench.js']

describe('snapshot', () => {
  it('records a sha256 per file', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    expect(Object.keys(m.files).sort()).toEqual(files)
    expect(m.files['src/a.test.js']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('copies the content into the store, preserving relative paths', async () => {
    await seed()
    await snapshot(repo, store, files)
    expect(await readFile(join(store, 'src/a.test.js'), 'utf8')).toBe('original a\n')
  })

  it('refuses to freeze a symlinked file', async () => {
    await seed()
    await writeFile(join(repo, 'outside.js'), 'x\n')
    await rm(join(repo, 'src/a.test.js'))
    await symlink(join(repo, 'outside.js'), join(repo, 'src/a.test.js'))
    await expect(snapshot(repo, store, files)).rejects.toMatchObject({ code: ERR_SYMLINK })
  })

  it('refuses to freeze through a symlinked parent directory', async () => {
    await seed()
    await mkdir(join(repo, 'elsewhere'), { recursive: true })
    await writeFile(join(repo, 'elsewhere/a.test.js'), 'x\n')
    await rm(join(repo, 'src'), { recursive: true })
    await symlink(join(repo, 'elsewhere'), join(repo, 'src'))
    await expect(snapshot(repo, store, ['src/a.test.js'])).rejects.toMatchObject({ code: ERR_SYMLINK })
  })

  it('rejects a path escaping the repository root', async () => {
    await seed()
    await expect(snapshot(repo, store, ['../outside.js'])).rejects.toThrow(/escapes/)
  })
})

describe('restore', () => {
  it('rewrites an edited file and reports it', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await writeFile(join(repo, 'src/a.test.js'), 'weakened\n')
    expect(await restore(repo, store, m)).toEqual(['src/a.test.js'])
    expect(await readFile(join(repo, 'src/a.test.js'), 'utf8')).toBe('original a\n')
  })

  it('recreates a deleted file', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await rm(join(repo, 'src/b.bench.js'))
    expect(await restore(repo, store, m)).toEqual(['src/b.bench.js'])
    expect(await readFile(join(repo, 'src/b.bench.js'), 'utf8')).toBe('original b\n')
  })

  it('reports nothing when the tree already matches', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    expect(await restore(repo, store, m)).toEqual([])
  })

  it('refuses to write through a symlink that appeared after baseline', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await rm(join(repo, 'src/a.test.js'))
    await writeFile(join(repo, 'target.js'), 'x\n')
    await symlink(join(repo, 'target.js'), join(repo, 'src/a.test.js'))
    await expect(restore(repo, store, m)).rejects.toMatchObject({ code: ERR_SYMLINK })
    expect(await readFile(join(repo, 'target.js'), 'utf8')).toBe('x\n')
  })

  it('detects a rewritten golden copy rather than restoring it', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await writeFile(join(store, 'src/a.test.js'), 'tampered\n')
    await writeFile(join(repo, 'src/a.test.js'), 'edited\n')
    await expect(restore(repo, store, m)).rejects.toMatchObject({ code: ERR_STORE_TAMPERED })
  })

  it('restores in sorted order for a deterministic report', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await writeFile(join(repo, 'src/a.test.js'), 'x\n')
    await writeFile(join(repo, 'src/b.bench.js'), 'y\n')
    expect(await restore(repo, store, m)).toEqual(['src/a.test.js', 'src/b.bench.js'])
  })
})

describe('verify', () => {
  it('reports nothing for an untouched tree', async () => {
    await seed()
    expect(await verify(repo, await snapshot(repo, store, files))).toEqual([])
  })

  it('reports an edited and a deleted file as changed', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await writeFile(join(repo, 'src/a.test.js'), 'edited\n')
    await rm(join(repo, 'src/b.bench.js'))
    expect(await verify(repo, m)).toEqual(['src/a.test.js', 'src/b.bench.js'])
  })

  it('reports a symlinked path as changed rather than following it', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    await rm(join(repo, 'src/a.test.js'))
    await writeFile(join(repo, 't.js'), 'original a\n')
    await symlink(join(repo, 't.js'), join(repo, 'src/a.test.js'))
    expect(await verify(repo, m)).toContain('src/a.test.js')
  })
})

describe('manifest persistence', () => {
  it('round-trips through disk', async () => {
    await seed()
    const m = await snapshot(repo, store, files)
    const path = join(store, 'manifest.json')
    await saveManifest(path, m)
    expect(await loadManifest(path)).toEqual(m)
  })

  it('errors clearly when the manifest is missing', async () => {
    await expect(loadManifest(join(store, 'nope.json'))).rejects.toThrow(/read manifest/)
  })
})
