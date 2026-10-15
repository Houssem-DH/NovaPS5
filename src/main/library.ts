import { promises as fsp } from 'fs'
import path from 'path'
import { libraryFile, ensureDir } from './paths'
import type { Game, LibraryData } from '@shared/types'

let cache: LibraryData | null = null

async function load(): Promise<LibraryData> {
  if (cache) return cache
  try {
    const raw = await fsp.readFile(libraryFile(), 'utf8')
    // Tolerate a leading BOM (editors like Notepad/PowerShell add one) — a BOM
    // would otherwise make JSON.parse throw and silently reset the library.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text) as LibraryData
    cache = { games: Array.isArray(parsed.games) ? parsed.games : [] }
  } catch {
    cache = { games: [] }
  }
  return cache
}

async function persist(): Promise<void> {
  if (!cache) return
  ensureDir(path.dirname(libraryFile()))
  await fsp.writeFile(libraryFile(), JSON.stringify(cache, null, 2), 'utf8')
}

/** Turn a display name into a safe folder/id slug. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'game'
}

export async function listGames(): Promise<Game[]> {
  const data = await load()
  return [...data.games].sort((a, b) => b.installedAt - a.installedAt)
}

export async function getGame(id: string): Promise<Game | undefined> {
  const data = await load()
  return data.games.find((game) => game.id === id)
}

export async function addGame(game: Game): Promise<void> {
  const data = await load()
  const index = data.games.findIndex((g) => g.id === game.id)
  if (index >= 0) data.games[index] = game
  else data.games.push(game)
  await persist()
}

/** Remove a game from the index and delete its installed folder from disk. */
export async function removeGame(id: string): Promise<void> {
  const data = await load()
  const game = data.games.find((g) => g.id === id)
  data.games = data.games.filter((g) => g.id !== id)
  await persist()
  if (game) {
    await fsp.rm(game.installPath, { recursive: true, force: true }).catch(() => {})
  }
}

export async function touchPlay(id: string): Promise<void> {
  const data = await load()
  const game = data.games.find((g) => g.id === id)
  if (game) {
    game.lastPlayedAt = Date.now()
    await persist()
  }
}

/** Rewrite paths of games that were relocated on disk (custom games folder). */
export async function relocateGames(
  updates: Array<Pick<Game, 'id' | 'installPath' | 'exePath'>>
): Promise<void> {
  const data = await load()
  for (const update of updates) {
    const game = data.games.find((g) => g.id === update.id)
    if (game) {
      game.installPath = update.installPath
      game.exePath = update.exePath
    }
  }
  await persist()
}
