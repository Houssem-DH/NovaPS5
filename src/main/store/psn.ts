// PlayStation Store metadata client.
//
// This only reads *catalog metadata* — titles, publisher, cover art, release
// date and genres — from the public PlayStation Store endpoints. It never
// resolves or downloads game content. Installing a game is driven by a dump
// the user already has, or by a self-hosted catalog they point NovaPS5 at
// (see catalog.ts).

import type { StoreGame, StoreRegion, StoreSearchQuery, StoreSearchResult } from '@shared/types'

export const STORE_REGIONS: StoreRegion[] = [
  { code: 'GB', language: 'en', label: 'United Kingdom' },
  { code: 'IE', language: 'en', label: 'Ireland' },
  { code: 'DE', language: 'de', label: 'Germany' },
  { code: 'FR', language: 'fr', label: 'France' },
  { code: 'ES', language: 'es', label: 'Spain' },
  { code: 'IT', language: 'it', label: 'Italy' },
  { code: 'NL', language: 'nl', label: 'Netherlands' },
  { code: 'AT', language: 'de', label: 'Austria' },
  { code: 'CH', language: 'de', label: 'Switzerland' },
  { code: 'AU', language: 'en', label: 'Australia' },
  { code: 'JP', language: 'ja', label: 'Japan' },
  { code: 'US', language: 'en', label: 'United States' }
]

const DEFAULT_REGION = STORE_REGIONS[0]

const GENRE_LABELS: Record<string, string> = {
  ACTION: 'Action',
  ADVENTURE: 'Adventure',
  ARCADE: 'Arcade',
  BRAIN_TRAINING: 'Brain Training',
  CASUAL: 'Casual',
  EDUCATIONAL: 'Educational',
  FAMILY: 'Family',
  FIGHTING: 'Fighting',
  FITNESS: 'Fitness',
  HORROR: 'Horror',
  MUSICRHYTHM: 'Music/Rhythm',
  PARTY: 'Party',
  PUZZLE: 'Puzzle',
  QUIZ: 'Quiz',
  RACING: 'Racing',
  ROLE_PLAYING_GAMES: 'RPG',
  SHOOTER: 'Shooter',
  SIMULATION: 'Simulation',
  SIMULATOR: 'Simulator',
  SPORTS: 'Sports',
  STRATEGY: 'Strategy',
  UNIQUE: 'Unique'
}

/** Genres shown as filter chips in the store. */
export const STORE_GENRES: Array<{ key: string; label: string }> = [
  { key: 'action', label: 'Action' },
  { key: 'adventure', label: 'Adventure' },
  { key: 'role_playing_games', label: 'RPG' },
  { key: 'shooter', label: 'Shooter' },
  { key: 'racing', label: 'Racing' },
  { key: 'sports', label: 'Sports' },
  { key: 'horror', label: 'Horror' },
  { key: 'puzzle', label: 'Puzzle' },
  { key: 'simulation', label: 'Simulation' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'fighting', label: 'Fighting' },
  { key: 'family', label: 'Family' }
]

/** Hand-picked hero titles, resolved through the store search. */
const FEATURED_TITLES = [
  'ASTRO BOT',
  'Marvels Spider Man 2',
  'God of War Ragnarök',
  'Horizon Forbidden West',
  'Gran Turismo 7',
  'Ghost of Tsushima',
  'Hogwarts Legacy',
  'Cyberpunk 2077',
  'Baldurs Gate 3',
  'The Last of Us Part I'
]

// A request that hangs would otherwise leave the store spinning forever.
const REQUEST_TIMEOUT_MS = 15_000

// Small response cache so switching tabs does not hammer the store.
const cache = new Map<string, { at: number; ttl: number; value: unknown }>()

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key)
    return null
  }
  return hit.value as T
}

function cacheSet(key: string, value: unknown, ttl: number): void {
  cache.set(key, { at: Date.now(), ttl, value })
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback
  return Math.min(max, Math.max(min, n))
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-GB,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    })
    if (!response.ok) throw new Error(`PlayStation Store returned ${response.status}`)
    return await response.json()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The PlayStation Store did not respond in time.')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function firstImage(images: any[], types: number[]): string | null {
  for (const type of types) {
    const image = images.find((candidate) => candidate?.type === type && typeof candidate?.url === 'string')
    if (image) return image.url as string
  }
  return null
}

function packageSize(link: any): number | null {
  let size = 0
  const entitlements: any[] = Array.isArray(link?.default_sku?.entitlements) ? link.default_sku.entitlements : []
  for (const entitlement of entitlements) {
    for (const pkg of Array.isArray(entitlement?.packages) ? entitlement.packages : []) {
      const platform = String(pkg?.platformName ?? '').toLowerCase()
      const bytes = Number(pkg?.size)
      if (platform === 'ps5' && Number.isFinite(bytes) && bytes > 0) size = Math.max(size, bytes)
    }
    const bytes = Number(entitlement?.size)
    if (Number.isFinite(bytes) && bytes > 0) size = Math.max(size, bytes)
  }
  return size > 0 ? size : null
}

function genreLabels(link: any): string[] {
  const raw: unknown[] = link?.metadata?.genre?.values ?? link?.metadata?.game_genre?.values ?? []
  const labels = new Set<string>()
  for (const value of raw) {
    const key = String(value).toUpperCase()
    const label =
      GENRE_LABELS[key] ??
      key
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    if (label) labels.add(label)
  }
  return [...labels]
}

function storeLocale(region: StoreRegion): string {
  return `${region.language}-${region.code}`.toLowerCase()
}

const ALLOWED_CLASSIFICATIONS = new Set([
  'FULL_GAME',
  'PREMIUM_EDITION',
  'BUNDLE',
  'GAME_BUNDLE',
  'DELUXE_EDITION',
  'ULTIMATE_EDITION',
  'STANDARD_EDITION'
])

/** Turn one chihiro/tumbler product into a StoreGame, or null when it is not a PS5 game. */
function parseProduct(link: any, region: StoreRegion): StoreGame | null {
  const productId = typeof link?.id === 'string' ? link.id : null
  if (!productId) return null

  const platforms: unknown[] = Array.isArray(link?.playable_platform) ? link.playable_platform : []
  if (!platforms.some((platform) => /ps5/i.test(String(platform)))) return null

  if (link?.top_category === 'add_on') return null
  const classification = link?.metadata?.store_display_classification?.values?.[0]
  if (typeof classification === 'string' && !ALLOWED_CLASSIFICATIONS.has(classification)) return null

  const name = String(link?.name ?? link?.title_name ?? '').trim()
  if (!name) return null

  const images: any[] = Array.isArray(link?.images) ? link.images : []
  const coverUrl = firstImage(images, [10, 1, 12, 13])
  if (!coverUrl) return null // without art the store grid would be a wall of blanks

  const titleMatch = productId.match(/(PPSA\d{5}|CUSA\d{5})/)

  return {
    id: `psn:${productId}`,
    source: 'psn',
    name,
    titleId: titleMatch ? titleMatch[1] : null,
    publisher: typeof link?.provider_name === 'string' ? link.provider_name : null,
    genres: genreLabels(link),
    releaseDate: typeof link?.release_date === 'string' ? link.release_date : null,
    coverUrl,
    heroUrl: firstImage(images, [12, 13, 14, 10]),
    sizeBytes: packageSize(link),
    downloadUrl: null,
    sha256: null,
    storeUrl: `https://store.playstation.com/${storeLocale(region)}/product/${encodeURIComponent(productId)}`
  }
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\b(ps4|ps5)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Keep one entry per title (cross-gen listings otherwise appear twice). */
function dedupeGames(games: StoreGame[]): StoreGame[] {
  const seen = new Set<string>()
  const out: StoreGame[] = []
  for (const game of games) {
    const key = normalizeName(game.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(game)
  }
  return out
}

function matchesGenre(game: StoreGame, genre: string | undefined): boolean {
  if (!genre) return true
  const label = GENRE_LABELS[genre.toUpperCase()] ?? genre
  return game.genres.some((value) => value.toLowerCase() === label.toLowerCase())
}

function pageResult(
  games: StoreGame[],
  total: number,
  offset: number,
  size: number,
  region: StoreRegion,
  error?: string
): StoreSearchResult {
  return {
    games,
    total,
    offset,
    size,
    hasMore: offset + size < total,
    region: region.code,
    error
  }
}

/** Browse PS5 full games from the store, newest first. */
export async function browsePsn(
  query: StoreSearchQuery = {},
  region: StoreRegion = DEFAULT_REGION
): Promise<StoreSearchResult> {
  const requestedSize = clampInt(query.size, 1, 100, 40)
  // The storefront edge cache builds its key from size/start but ignores the
  // genre parameter, so two genre pages fetched with the same shape can
  // collide. Give every genre a distinct page size to keep them honest.
  const genreIndex = query.genre ? STORE_GENRES.findIndex((entry) => entry.key === query.genre) : -1
  const size = Math.min(100, requestedSize + (genreIndex >= 0 ? genreIndex + 1 : 0))
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  const params = new URLSearchParams({
    size: String(size),
    start: String(offset),
    game_content_type: 'games',
    platform: 'ps5',
    sort: 'release_date',
    direction: 'desc'
  })
  if (query.genre) {
    params.set('genre', query.genre)
  } else {
    // The unfiltered catalog starts with 2027 pre-orders. The "last 30 days"
    // facet gives the storefront a real new-releases shelf instead.
    params.set('release_date', 'last_30_days')
  }

  const fetchFor = (target: StoreRegion): Promise<any> =>
    fetchJson(
      `https://store.playstation.com/store/api/chihiro/00_09_000/container/${target.code}/${target.language}/999/STORE-MSF75508-FULLGAMES?${params.toString()}`
    )

  let used = region
  let json: any
  try {
    json = await fetchFor(region)
  } catch (error) {
    if (region.code === DEFAULT_REGION.code) throw error
    // Not every region exposes this catalog. Rather than empty the store,
    // fall back to the region we know works and say so.
    used = DEFAULT_REGION
    json = await fetchFor(used)
  }

  const links: any[] = Array.isArray(json?.links) ? json.links : []
  const games = dedupeGames(
    links
      .map((link) => parseProduct(link, used))
      .filter((game): game is StoreGame => game !== null)
      .filter((game) => matchesGenre(game, query.genre))
  )
  const total = Math.max(Number(json?.total_results) || 0, offset + games.length)
  return pageResult(
    games,
    total,
    offset,
    size,
    used,
    used.code !== region.code ? `The ${region.label} catalog is unavailable — showing ${used.label}.` : undefined
  )
}

/** Search the store by title, keeping only PS5 games. */
export async function searchPsn(
  query: StoreSearchQuery = {},
  region: StoreRegion = DEFAULT_REGION
): Promise<StoreSearchResult> {
  const rawText = (query.text ?? '').trim()
  // The storefront search treats apostrophes as a hard separator and often
  // returns nothing at all ("Demon's Souls" → 0, "Demons Souls" → 3). Drop them
  // (and trademark marks) before querying.
  const text = rawText.replace(/['’™®©]/g, '').replace(/\s+/g, ' ').trim()
  if (!text) return browsePsn(query, region)

  const size = clampInt(query.size, 1, 40, 30)
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  // Search results mix PS3/PS4/add-on products, so a raw page can filter down to
  // nothing. Walk a few raw pages until we have something to show, and advance
  // the caller's offset by however many raw products we consumed.
  const wanted = Math.min(size, 12)
  const collected: StoreGame[] = []
  let cursor = offset
  let total = 0

  for (let page = 0; page < 4; page += 1) {
    const url =
      `https://store.playstation.com/store/api/chihiro/00_09_000/tumbler/` +
      `${region.code}/${region.language}/999/${encodeURIComponent(text)}` +
      `?size=${size}&mode=game&start=${cursor}`
    const json = await fetchJson(url)
    total = Math.max(total, Number(json?.total_results) || 0)
    const links: any[] = Array.isArray(json?.links) ? json.links : []
    collected.push(
      ...links
        .map((link) => parseProduct(link, region))
        .filter((game): game is StoreGame => game !== null)
        .filter((game) => matchesGenre(game, query.genre))
    )
    cursor += size
    if (collected.length >= wanted || cursor >= total || links.length === 0) break
  }

  const games = dedupeGames(collected)
  const consumed = Math.max(size, cursor - offset)
  return pageResult(games, Math.max(total, offset + games.length), offset, consumed, region)
}

/** Resolve the featured hero list (cached for 15 minutes). */
export async function featuredPsn(region: StoreRegion = DEFAULT_REGION): Promise<StoreGame[]> {
  const key = `featured:${region.code}`
  const cached = cacheGet<StoreGame[]>(key)
  if (cached) return cached

  const results = await Promise.allSettled(
    FEATURED_TITLES.map((title) => searchPsn({ text: title, size: 5 }, region))
  )
  const games: StoreGame[] = []
  const seen = new Set<string>()
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status !== 'fulfilled') continue
    const wanted = normalizeName(FEATURED_TITLES[index])
    // Prefer an exact title match (so "The Last of Us Part I" does not resolve
    // to the Complete bundle), then fall back to the first PS5 match.
    const match =
      result.value.games.find((game) => !seen.has(game.id) && normalizeName(game.name) === wanted) ??
      result.value.games.find((game) => !seen.has(game.id))
    if (match) {
      seen.add(match.id)
      games.push(match)
    }
  }
  // Do not cache a total failure; the next mount should retry the storefront.
  if (games.length > 0) cacheSet(key, games, 15 * 60_000)
  return games
}
