// Persistence for the store: region/catalog settings plus the user's store
// library (games they added, and their download/install state).

import { promises as fsp } from 'fs'
import path from 'path'
import { ensureDir, libraryRoot } from '../paths'
import type { StoreEntry, StoreGame, StoreSettings } from '@shared/types'

interface StoreFile {
  settings: StoreSettings
  entries: StoreEntry[]
}

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  region: 'GB',
  language: 'en',
  catalogUrl: null
}

function storeFile(): string {
  return path.join(libraryRoot(), 'store.json')
}

let cache: StoreFile | null = null
let loading: Promise<StoreFile> | null = null
let persistQueue: Promise<void> = Promise.resolve()

function sanitizeSettings(value: unknown): StoreSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<StoreSettings>
  return {
    region: typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim().toUpperCase() : DEFAULT_STORE_SETTINGS.region,
    language:
      typeof raw.language === 'string' && raw.language.trim()
        ? raw.language.trim().toLowerCase()
        : DEFAULT_STORE_SETTINGS.language,
    catalogUrl: typeof raw.catalogUrl === 'string' && raw.catalogUrl.trim() ? raw.catalogUrl.trim() : null
  }
}

function sanitizeEntry(value: unknown): StoreEntry | null {
  const raw = value as Partial<StoreEntry> | null
  if (!raw) return null
  const game = raw.game as Partial<StoreGame> | undefined
  if (!game || typeof game.id !== 'string' || typeof game.name !== 'string') return null
  return {
    game: {
      id: game.id,
      source: game.source === 'catalog' ? 'catalog' : 'psn',
      name: game.name,
      titleId: typeof game.titleId === 'string' ? game.titleId : null,
      publisher: typeof game.publisher === 'string' ? game.publisher : null,
      genres: Array.isArray(game.genres) ? game.genres.map(String) : [],
      releaseDate: typeof game.releaseDate === 'string' ? game.releaseDate : null,
      coverUrl: typeof game.coverUrl === 'string' ? game.coverUrl : null,
      heroUrl: typeof game.heroUrl === 'string' ? game.heroUrl : null,
      sizeBytes: Number.isFinite(Number(game.sizeBytes)) ? Number(game.sizeBytes) : null,
      downloadUrl: typeof game.downloadUrl === 'string' ? game.downloadUrl : null,
      sha256: typeof game.sha256 === 'string' ? game.sha256 : null,
      storeUrl: typeof game.storeUrl === 'string' ? game.storeUrl : null
    },
    addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : Date.now(),
    status:
      raw.status === 'downloading' || raw.status === 'downloaded' || raw.status === 'installed'
        ? raw.status
        : 'wishlist',
    localPath: typeof raw.localPath === 'string' ? raw.localPath : undefined,
    installedGameId: typeof raw.installedGameId === 'string' ? raw.installedGameId : undefined
  }
}

async function readStoreFile(file: string): Promise<StoreFile> {
  const raw = await fsp.readFile(file, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const parsed = JSON.parse(text) as Partial<StoreFile>
  return {
    settings: sanitizeSettings(parsed?.settings),
    entries: Array.isArray(parsed?.entries)
      ? (parsed.entries.map(sanitizeEntry).filter(Boolean) as StoreEntry[])
      : []
  }
}

async function load(): Promise<StoreFile> {
  if (cache) return cache
  // Collapse concurrent first reads onto one promise so every caller mutates
  // the same object (adding two games at once must not drop one).
  if (loading) return loading
  loading = (async () => {
    const empty: StoreFile = { settings: { ...DEFAULT_STORE_SETTINGS }, entries: [] }
    let loaded: StoreFile
    try {
      loaded = await readStoreFile(storeFile())
    } catch {
      // Fall back to the previous good copy, exactly like the game library.
      try {
        loaded = await readStoreFile(`${storeFile()}.bak`)
      } catch {
        loaded = empty
      }
    }
    cache = loaded
    return loaded
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

function persist(): Promise<void> {
  // Serialize writes: download progress updates and user actions can overlap,
  // and two writers must not race on the same temp file.
  const task = persistQueue.then(async () => {
    if (!cache) return
    const file = storeFile()
    ensureDir(path.dirname(file))
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
    await fsp.copyFile(file, `${file}.bak`).catch(() => {})
    await fsp.rename(tmp, file)
  })
  persistQueue = task.catch(() => {})
  return task
}

export async function getStoreSettings(): Promise<StoreSettings> {
  return { ...(await load()).settings }
}

export async function updateStoreSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
  const data = await load()
  data.settings = sanitizeSettings({ ...data.settings, ...patch })
  await persist()
  return { ...data.settings }
}

export async function listStoreEntries(): Promise<StoreEntry[]> {
  const data = await load()
  return [...data.entries].sort((a, b) => b.addedAt - a.addedAt)
}

export async function getStoreEntry(id: string): Promise<StoreEntry | undefined> {
  return (await load()).entries.find((entry) => entry.game.id === id)
}

export async function addStoreEntry(game: StoreGame): Promise<StoreEntry[]> {
  const data = await load()
  const existing = data.entries.find((entry) => entry.game.id === game.id)
  if (existing) {
    // Refresh metadata but never lose where the entry got to — including a
    // download URL the user attached, which catalog/PSN refreshes don't carry.
    existing.game = {
      ...game,
      downloadUrl: game.downloadUrl ?? existing.game.downloadUrl,
      sha256: game.sha256 ?? existing.game.sha256
    }
  } else {
    data.entries.push({ game: { ...game }, addedAt: Date.now(), status: 'wishlist' })
  }
  await persist()
  return listStoreEntries()
}

export async function removeStoreEntry(id: string): Promise<StoreEntry[]> {
  const data = await load()
  data.entries = data.entries.filter((entry) => entry.game.id !== id)
  await persist()
  return listStoreEntries()
}

export async function setStoreDownloadUrl(id: string, url: string | null): Promise<StoreEntry[]> {
  const data = await load()
  const entry = data.entries.find((candidate) => candidate.game.id === id)
  if (!entry) throw new Error('Add this game to your library before giving it a download URL.')
  entry.game.downloadUrl = url?.trim() ? url.trim() : null
  await persist()
  return listStoreEntries()
}

export async function updateStoreEntry(
  id: string,
  patch: Partial<Pick<StoreEntry, 'status' | 'localPath' | 'installedGameId'>>
): Promise<void> {
  const data = await load()
  const entry = data.entries.find((candidate) => candidate.game.id === id)
  if (!entry) return
  if (patch.status) entry.status = patch.status
  if (patch.localPath !== undefined) entry.localPath = patch.localPath
  if (patch.installedGameId !== undefined) entry.installedGameId = patch.installedGameId
  await persist()
}
