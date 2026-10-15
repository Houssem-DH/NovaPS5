import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { ensureDir, gamesRoot, loadConfig, saveConfig } from './paths'
import { listGames, relocateGames } from './library'
import type { SetGamesDirResult } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * Move a folder to another volume. rename() only works within one volume, so
 * fall back to xcopy + delete for cross-drive moves (D: → C: etc.).
 */
async function moveDir(src: string, dst: string): Promise<void> {
  try {
    await fsp.rename(src, dst)
    return
  } catch {
    // different volume — copy then remove
  }
  try {
    await execFileAsync('xcopy', [src, dst, '/E', '/I', '/H', '/Y', '/Q'], { windowsHide: true })
  } catch (error) {
    // xcopy exits 1 when nothing was found to copy — anything else is real.
    const code = (error as { code?: number }).code
    if (code !== 1) throw error
  }
  ensureDir(dst)
  await fsp.rm(src, { recursive: true, force: true })
}

/**
 * Point new installs at `dir`, moving every game currently living under the
 * old games folder with it (the user chose to relocate the whole set).
 * Library entries are rewritten after each move so a mid-way failure never
 * leaves the index pointing at vanished folders.
 */
export async function setGamesDir(dir: string): Promise<SetGamesDirResult> {
  const target = path.resolve(dir)
  const current = path.resolve(gamesRoot())
  if (target === current) return { ok: true, moved: 0 }

  try {
    ensureDir(target)
  } catch (error) {
    return { ok: false, moved: 0, error: error instanceof Error ? error.message : String(error) }
  }

  const games = await listGames()
  const moving = games.filter((g) => path.resolve(path.dirname(g.installPath)) === current)

  // Pre-flight: never clobber an existing folder in the destination.
  for (const game of moving) {
    const dest = path.join(target, path.basename(game.installPath))
    if (path.resolve(dest) !== path.resolve(game.installPath) && fs.existsSync(dest)) {
      return {
        ok: false,
        moved: 0,
        error: `A folder named "${path.basename(game.installPath)}" already exists in the chosen directory.`
      }
    }
  }

  let moved = 0
  try {
    for (const game of moving) {
      const dest = path.join(target, path.basename(game.installPath))
      if (path.resolve(dest) !== path.resolve(game.installPath)) {
        await moveDir(game.installPath, dest)
      }
      const exePath = game.exePath.startsWith(game.installPath)
        ? dest + game.exePath.slice(game.installPath.length)
        : path.join(dest, path.basename(game.exePath))
      await relocateGames([{ id: game.id, installPath: dest, exePath }])
      moved++
    }
    saveConfig({ ...loadConfig(), gamesDir: target })
    ensureDir(gamesRoot())
    return { ok: true, moved }
  } catch (error) {
    return {
      ok: false,
      moved,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
