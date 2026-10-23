import { create } from 'zustand'
import type {
  StoreDownloadProgress,
  StoreEntry,
  StoreGame,
  StoreRegion,
  StoreSearchResult,
  StoreSettings
} from '@shared/types'

const PAGE_SIZE = 36

// Guards against out-of-order page responses (rapid genre/search changes).
let pageRequest = 0

function featuredKey(settings: StoreSettings | null): string {
  return `${settings?.region ?? ''}|${settings?.catalogUrl ?? ''}`
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
}

function dedupeGames(games: StoreGame[]): StoreGame[] {
  const seen = new Set<string>()
  return games.filter((game) => {
    if (seen.has(game.id)) return false
    seen.add(game.id)
    return true
  })
}

interface StoreState {
  regions: StoreRegion[]
  settings: StoreSettings | null
  entries: StoreEntry[]
  featured: StoreGame[]
  games: StoreGame[]
  total: number
  offset: number
  hasMore: boolean
  query: string
  genre: string
  mode: 'discover' | 'library'
  loading: boolean
  loadingMore: boolean
  /** True once the initial settings/entries/featured load has run. */
  loaded: boolean
  error: string | null
  activeGame: StoreGame | null
  progress: Record<string, StoreDownloadProgress>

  load: () => Promise<void>
  fetchPage: (reset?: boolean) => Promise<void>
  setQuery: (query: string) => void
  setGenre: (genre: string) => void
  setMode: (mode: 'discover' | 'library') => void
  loadMore: () => Promise<void>
  refreshLibrary: () => Promise<void>
  addToLibrary: (game: StoreGame) => Promise<void>
  removeFromLibrary: (id: string) => Promise<void>
  setDownloadUrl: (id: string, url: string | null) => Promise<void>
  download: (id: string, url?: string) => Promise<void>
  installLocal: (id: string, sourcePath: string) => Promise<void>
  saveSettings: (patch: Partial<StoreSettings>) => Promise<void>
  openGame: (game: StoreGame | null) => void
  setProgress: (progress: StoreDownloadProgress) => void
  entryFor: (id: string) => StoreEntry | undefined
}

export const useStore = create<StoreState>((set, get) => ({
  regions: [],
  settings: null,
  entries: [],
  featured: [],
  games: [],
  total: 0,
  offset: 0,
  hasMore: false,
  query: '',
  genre: '',
  mode: 'discover',
  loading: true,
  loadingMore: false,
  loaded: false,
  error: null,
  activeGame: null,
  progress: {},

  load: async () => {
    // Re-entering the Games tab should not re-hit the storefront.
    if (get().loaded) return
    set({ loading: true, error: null })
    try {
      const [regions, settings, entries] = await Promise.all([
        window.api.storeRegions(),
        window.api.storeSettings(),
        window.api.storeLibrary()
      ])
      set({ regions, settings, entries })
      // Featured titles need several searches; let the grid render without
      // waiting on them (worst case a slow storefront would block the page).
      const key = featuredKey(settings)
      void window.api
        .storeFeatured()
        .then((featured) => {
          if (featuredKey(get().settings) === key) set({ featured })
        })
        .catch(() => {})
    } catch (error) {
      set({ error: message(error) })
    }
    await get().fetchPage(true)
    set({ loading: false, loaded: true })
  },

  fetchPage: async (reset = true) => {
    const request = ++pageRequest
    const { query, genre, offset } = get()
    const pageOffset = reset ? 0 : offset
    set(reset ? { loading: true, error: null } : { loadingMore: true })
    try {
      const result: StoreSearchResult = query.trim()
        ? await window.api.storeSearch({
            text: query.trim(),
            genre: genre || undefined,
            offset: pageOffset,
            size: PAGE_SIZE
          })
        : await window.api.storeBrowse({
            genre: genre || undefined,
            offset: pageOffset,
            size: PAGE_SIZE
          })

      if (request !== pageRequest) return
      set((state) => ({
        games: reset ? result.games : dedupeGames([...state.games, ...result.games]),
        total: result.total,
        offset: result.offset + result.size,
        hasMore: result.hasMore,
        error: result.error ?? null
      }))
    } catch (error) {
      if (request !== pageRequest) return
      set({ error: message(error), ...(reset ? { games: [], hasMore: false } : {}) })
    } finally {
      if (request === pageRequest) set({ loading: false, loadingMore: false })
    }
  },

  setQuery: (query) => set({ query }),
  setGenre: (genre) => set({ genre }),
  setMode: (mode) => set({ mode }),

  loadMore: async () => {
    if (get().loading || get().loadingMore || !get().hasMore) return
    await get().fetchPage(false)
  },

  refreshLibrary: async () => {
    const entries = await window.api.storeLibrary()
    set({ entries })
  },

  addToLibrary: async (game) => {
    const entries = await window.api.storeAdd(game)
    set({ entries })
  },

  removeFromLibrary: async (id) => {
    const entries = await window.api.storeRemove(id)
    set((state) => ({
      entries,
      activeGame: state.activeGame?.id === id ? null : state.activeGame
    }))
  },

  setDownloadUrl: async (id, url) => {
    const entries = await window.api.storeSetDownload(id, url)
    set((state) => ({
      entries,
      activeGame:
        state.activeGame && state.activeGame.id === id
          ? { ...state.activeGame, downloadUrl: url?.trim() || null }
          : state.activeGame
    }))
  },

  download: async (id, url) => {
    await window.api.storeDownload(id, url)
    await get().refreshLibrary()
  },

  installLocal: async (id, sourcePath) => {
    await window.api.storeInstallLocal(id, sourcePath)
  },

  saveSettings: async (patch) => {
    set({ loading: true, error: null })
    try {
      const settings = await window.api.storeSetSettings(patch)
      const entries = await window.api.storeLibrary()
      set({ settings, entries, featured: [] })
      // The new region's featured list can arrive after the grid.
      const key = featuredKey(settings)
      void window.api
        .storeFeatured()
        .then((featured) => {
          if (featuredKey(get().settings) === key) set({ featured })
        })
        .catch(() => {})
      await get().fetchPage(true)
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  openGame: (game) => set({ activeGame: game }),

  setProgress: (progress) =>
    set((state) => ({
      progress: { ...state.progress, [progress.gameId]: progress }
    })),

  entryFor: (id) => get().entries.find((entry) => entry.game.id === id)
}))
