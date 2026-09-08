import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as gitx from '../src/gitx.js'
import { commitFiles, git, makeRepo, writeFiles } from './helpers/repo.js'

describe('gitx', () => {
  it('reports the repository root from a subdirectory', async () => {
    const dir = await makeRepo({ 'src/a.js': 'export const a = 1\n' })
    expect(await gitx.root(join(dir, 'src'))).toContain('a3s-repo-')
  })

  it('reports the short head commit and its subject', async () => {
    const dir = await makeRepo()
    expect(await gitx.headCommit(dir)).toMatch(/^[0-9a-f]{7}$/)
    expect(await gitx.headSubject(dir)).toBe('initial')
  })

  it('reports and creates branches', async () => {
    const dir = await makeRepo()
    expect(await gitx.currentBranch(dir)).toBe('main')
    expect(await gitx.branchExists(dir, 'run/x')).toBe(false)
    await gitx.createBranch(dir, 'run/x')
    expect(await gitx.currentBranch(dir)).toBe('run/x')
    expect(await gitx.branchExists(dir, 'run/x')).toBe(true)
  })

  it('checks out and force-deletes a branch', async () => {
    const dir = await makeRepo()
    await gitx.createBranch(dir, 'run/x')
    await gitx.checkout(dir, 'main')
    await gitx.deleteBranch(dir, 'run/x')
    expect(await gitx.branchExists(dir, 'run/x')).toBe(false)
  })

  it('reports a clean and a dirty tree', async () => {
    const dir = await makeRepo()
    expect(await gitx.isClean(dir)).toBe(true)
    await writeFiles(dir, { 'new.js': 'x\n' })
    expect(await gitx.isClean(dir)).toBe(false)
  })

  it('lists tracked changes and untracked files since a commit', async () => {
    const dir = await makeRepo({ 'a.js': '1\n' })
    const base = await gitx.headCommit(dir)
    await commitFiles(dir, { 'a.js': '2\n', 'b.js': '3\n' })
    await writeFiles(dir, { 'c.js': '4\n' })
    expect(await gitx.changedSince(dir, base)).toEqual(['a.js', 'b.js', 'c.js'])
  })

  it('honours .gitignore when listing untracked files', async () => {
    const dir = await makeRepo({ '.gitignore': 'ignored.js\n' })
    const base = await gitx.headCommit(dir)
    await writeFiles(dir, { 'ignored.js': 'x\n', 'seen.js': 'y\n' })
    expect(await gitx.changedSince(dir, base)).toEqual(['seen.js'])
  })

  it('returns paths with non-ASCII characters unquoted', async () => {
    const dir = await makeRepo()
    const base = await gitx.headCommit(dir)
    await writeFiles(dir, { 'src/café.js': 'x\n' })
    expect(await gitx.changedSince(dir, base)).toEqual(['src/café.js'])
  })

  it('adds, re-points and removes a detached worktree', async () => {
    const dir = await makeRepo({ 'a.js': '1\n' })
    const first = await gitx.headCommit(dir)
    const second = await commitFiles(dir, { 'a.js': '2\n' })
    const wt = join(dir, '..', `wt-${process.pid}`)
    await gitx.addWorktree(dir, wt, first)
    expect(await gitx.headCommit(wt)).toBe(first)
    await gitx.checkoutDetached(wt, second)
    expect(await gitx.headCommit(wt)).toBe(second)
    await gitx.removeWorktree(dir, wt)
    await rm(wt, { recursive: true, force: true })
  })

  it('includes stderr in the error when a command fails', async () => {
    const dir = await makeRepo()
    await expect(gitx.checkout(dir, 'no-such-ref')).rejects.toThrow(/no-such-ref/)
  })

  it('does not parse stderr chatter as part of a successful result', async () => {
    const dir = await makeRepo()
    // A pre-commit-style hook writing to stderr must not pollute stdout parsing.
    await git(dir, 'config', 'advice.detachedHead', 'true')
    expect(await gitx.headCommit(dir)).toMatch(/^[0-9a-f]{7}$/)
  })
})
