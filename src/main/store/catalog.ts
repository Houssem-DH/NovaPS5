// Self-hosted catalog support.
//
// A catalog is a JSON file the user controls (on their own server, NAS, or
// disk) that describes dumps they already have and where the archive lives.
// NovaPS5 downloads from *that* URL only — never from Sony or third-party game
// sources. See docs/store-catalog.md for the format.

import { promises as fsp } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { StoreGame, StoreSettings } from '@shared/types'

const CATALOG_TTL_MS = 2 * 60_000
const MAX_EMBEDDED_COVER_BYTES = 4 * 1024 * 1024

const cache = new Map<string, { at: number; value: StoreGame[] }>()

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'game'
  )
}

function isHttp(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function resolveTarget(value: string, base: string | null): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isHttp(trimmed) || trimmed.startsWith('file://')) return trimmed
  if (!base) return trimmed
  if (isHttp(base)) {
    try {
      return new URL(trimmed, base).toString()
    } catch {
      return null
    }
  }
  return path.resolve(base, trimmed)
}

/** Local covers become data URLs so the renderer can display them. */
async function resolveCover(value: unknown, base: string | null): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  if (/^(https?:|data:)/i.test(raw)) return raw
  if (!base) return null

  if (isHttp(base)) {
    try {
      return new URL(raw, base).toString()
    } catch {
      return null
    }
  }

  try {
    const file = raw.startsWith('file://') ? fileURLToPath(raw) : path.resolve(base, raw)
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_EMBEDDED_COVER_BYTES) return null
    const data = await fsp.readFile(file)
    const ext = path.extname(file).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

async function toStoreGame(raw: any, base: string | null, index: number): Promise<StoreGame | null> {
  const name = String(raw?.name ?? raw?.title ?? '').trim()
  if (!name) return null
  const id = String(raw?.id ?? `${slug(name)}-${index}`).trim() || `${slug(name)}-${index}`
  const downloadUrl = resolveTarget(
    String(raw?.downloadUrl ?? raw?.download ?? raw?.url ?? '').trim(),
    base
  )

  return {
    id: `catalog:${id}`,
    source: 'catalog',
    name,
    titleId: typeof raw?.titleId === 'string' ? raw.titleId : null,
    publisher: typeof raw?.publisher === 'string' ? raw.publisher : null,
    genres: Array.isArray(raw?.genres) ? raw.genres.map(String) : [],
    releaseDate: typeof raw?.releaseDate === 'string' ? raw.releaseDate : null,
    coverUrl: (await resolveCover(raw?.coverUrl ?? raw?.cover, base)) ?? null,
    heroUrl: (await resolveCover(raw?.heroUrl ?? raw?.hero, base)) ?? null,
    sizeBytes: Number.isFinite(Number(raw?.sizeBytes)) ? Number(raw.sizeBytes) : null,
    downloadUrl,
    sha256: typeof raw?.sha256 === 'string' ? raw.sha256 : null,
    storeUrl: typeof raw?.storeUrl === 'string' ? raw.storeUrl : null
  }
}

async function readCatalog(source: string): Promise<{ text: string; base: string | null }> {
  if (isHttp(source)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(source, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      })
      if (!response.ok) throw new Error(`Catalog returned ${response.status}`)
      return { text: await response.text(), base: source }
    } finally {
      clearTimeout(timer)
    }
  }

  const file = source.startsWith('file://') ? fileURLToPath(source) : path.resolve(source)
  const text = await fsp.readFile(file, 'utf8')
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, base: path.dirname(file) }
}

/**
 * Load the user's catalog. Throws with a readable message when the source is
 * configured but unreachable/invalid; returns [] when no catalog is set.
 */
export async function loadCatalog(settings: StoreSettings): Promise<StoreGame[]> {
  const source = settings.catalogUrl?.trim()
  if (!source) return []

  const cached = cache.get(source)
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value

  const { text, base } = await readCatalog(source)
  const parsed = JSON.parse(text) as unknown
  const rawGames: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { games?: unknown[] })?.games)
      ? ((parsed as { games: unknown[] }).games as any[])
      : []

  const games = (
    await Promise.all(rawGames.map((raw, index) => toStoreGame(raw, base, index)))
  ).filter((game): game is StoreGame => game !== null)

  // Catalog entries without a download target are still useful as wishlist
  // metadata; they simply cannot be installed until a URL is attached.
  cache.set(source, { at: Date.now(), value: games })
  return games
}

export function invalidateCatalog(): void {
  cache.clear()
}
