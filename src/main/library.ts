import { promises as fsp } from 'fs'
import path from 'path'
import { libraryFile, ensureDir, gamesRoot } from './paths'
import type { Game, LibraryData } from '@shared/types'

let cache: LibraryData | null = null

async function load(): Promise<LibraryData> {
  if (cache) return cache
  cache = { games: [] }
  try {
    const raw = await fsp.readFile(libraryFile(), 'utf8')
    // Tolerate a leading BOM (editors like Notepad/PowerShell add one) — a BOM
    // would otherwise make JSON.parse throw and silently reset the library.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text) as LibraryData
    cache = { games: Array.isArray(parsed.games) ? parsed.games : [] }
  } catch {
    // The live file is missing or unreadable (e.g. a write was interrupted).
    // Fall back to the previous good copy rather than silently starting empty
    // — losing the user's whole library is never an acceptable recovery.
    try {
      const backup = await fsp.readFile(`${libraryFile()}.bak`, 'utf8')
      const text = backup.charCodeAt(0) === 0xfeff ? backup.slice(1) : backup
      const parsed = JSON.parse(text) as LibraryData
      if (Array.isArray(parsed.games)) cache = { games: parsed.games }
    } catch {
      /* no usable backup either — start with what we have (empty) */
    }
  }
  return cache
}

async function persist(): Promise<void> {
  if (!cache) return
  ensureDir(path.dirname(libraryFile()))
  const file = libraryFile()
  // Write to a temp file and rename it into place (atomic on the same volume),
  // keeping the previous version as .bak — an interrupted or concurrent write
  // can then never leave a half-written library behind.
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
  await fsp.copyFile(file, `${file}.bak`).catch(() => {})
  await fsp.rename(tmp, file)
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

// ---- Scan / repair ---------------------------------------------------------

export interface ScanSummary {
  /** Installs found on disk that were missing from the index. */
  added: number
  /** Entries whose folder/exe disappeared — flagged so the UI can show it. */
  missing: number
  /** Entries that recovered (folder/exe came back). */
  repaired: number
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/** Total size of a folder, best effort (a broken entry must not fail a scan). */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += await dirSize(full)
      } else {
        try {
          total += (await fsp.stat(full)).size
        } catch {
          /* unreadable file — ignore */
        }
      }
    }
  } catch {
    /* unreadable folder — report what we have */
  }
  return total
}

/** Best-effort title ID from an installed dump's param.json. */
async function readTitleId(dir: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, 'app0', 'sce_sys', 'param.json'), 'utf8')
    const parsed = JSON.parse(raw) as { titleId?: string }
    return typeof parsed.titleId === 'string' ? parsed.titleId : null
  } catch {
    return null
  }
}

/** Does this folder look like a game NovaPS5 installed (an exe + app0/)? */
async function looksInstalled(dir: string): Promise<string | null> {
  try {
    if (!(await exists(path.join(dir, 'app0')))) return null
    const files = await fsp.readdir(dir)
    const exe = files.find((f) => f.toLowerCase().endsWith('.exe'))
    return exe ?? null
  } catch {
    return null
  }
}

/**
 * Re-read the library from disk (dropping the in-memory cache), reconcile every
 * entry with what is actually installed, and adopt games that exist in the
 * games folder but are missing from the index. This is what the Library
 * "Scan" button runs — games that appeared on disk no longer require a restart.
 */
export async function scanLibrary(): Promise<{ games: Game[]; summary: ScanSummary }> {
  cache = null // force a fresh read from disk
  const data = await load()
  const summary: ScanSummary = { added: 0, missing: 0, repaired: 0 }

  // 1. Reconcile entries we already know about.
  for (const game of data.games) {
    const exeOk = await exists(game.exePath)
    const dirOk = await exists(game.installPath)
    if (exeOk) {
      if (game.status !== 'ready' || game.error) {
        game.status = 'ready'
        delete game.error
        summary.repaired++
      }
    } else {
      const detail = dirOk
        ? 'The game executable is missing — reinstall the game.'
        : 'The install folder is gone.'
      if (game.status !== 'error' || game.error !== detail) {
        game.status = 'error'
        game.error = detail
        summary.missing++
      }
    }
  }

  // 2. Adopt installs sitting in the games folder but absent from the index.
  const root = gamesRoot()
  let dirs: string[] = []
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.old'))
      .map((e) => e.name)
  } catch {
    dirs = []
  }

  const known = new Set(data.games.map((g) => path.resolve(g.installPath)))
  for (const name of dirs) {
    const dir = path.join(root, name)
    if (known.has(path.resolve(dir))) continue
    const exe = await looksInstalled(dir)
    if (!exe) continue

    let installedAt = Date.now()
    try {
      installedAt = (await fsp.stat(dir)).birthtimeMs || installedAt
    } catch {
      /* keep now() */
    }

    const game: Game = {
      id: name,
      name: path.basename(exe, path.extname(exe)),
      titleId: await readTitleId(dir),
      sourcePath: '',
      installPath: dir,
      exePath: path.join(dir, exe),
      sizeBytes: await dirSize(dir),
      cover: (await exists(path.join(dir, 'cover.png'))) ? 'cover.png' : null,
      status: 'ready',
      installedAt
    }
    data.games.push(game)
    summary.added++
  }

  if (summary.added > 0 || summary.missing > 0 || summary.repaired > 0) await persist()

  const games = [...data.games].sort((a, b) => b.installedAt - a.installedAt)
  return { games, summary }
}

