import { create } from 'zustand'
import type {
  AppInfo,
  ClearShaderCacheResult,
  Game,
  GameCompatibility,
  GameGraphics,
  InstallProgress,
  LibraryScanResult,
  UpdateState,
  WhatsNew
} from '@shared/types'

export type View = 'library' | 'store' | 'settings'

/**
 * The preload script is only evaluated when a window is created. If the app was
 * left running while `src/preload` changed, the renderer can be newer than the
 * bridge it is talking to. Fail with an actionable message instead of a raw
 * "window.api.setGameGraphics is not a function".
 */
function graphicsApi(): typeof window.api {
  if (
    typeof window.api?.setGameGraphics !== 'function' ||
    typeof window.api?.setGameCompatibility !== 'function' ||
    typeof window.api?.trophyPackage !== 'function' ||
    typeof window.api?.clearShaderCache !== 'function' ||
    typeof window.api?.session !== 'function' ||
    typeof window.api?.performance !== 'function' ||
    typeof window.api?.displays !== 'function'
  ) {
    throw new Error(
      'NovaPS5 is running an older preload script. Fully quit and restart the app (in development, stop and restart `npm run dev`) to load the game settings API.'
    )
  }
  return window.api
}

/** The same stale-preload check for components that only read graphics data. */
export function graphicsBridge(): typeof window.api {
  return graphicsApi()
}

interface LibraryState {
  games: Game[]
  loading: boolean
  appInfo: AppInfo | null
  installing: InstallProgress | null
  selectedId: string | null
  view: View
  installOpen: boolean
  /** False until the runtime bootstrap checklist finishes successfully. */
  bootstrapped: boolean
  /** Latest app-update status pushed from the main process. */
  update: UpdateState | null
  /** Release notes of the update installed by the last restart (shown once). */
  whatsNew: WhatsNew | null
  updateOpen: boolean

  load: () => Promise<void>
  refreshInfo: () => Promise<void>
  /** Re-read the library from disk, adopting installs missing from the index. */
  scan: () => Promise<LibraryScanResult>
  select: (id: string | null) => void
  setView: (view: View) => void
  setInstallOpen: (open: boolean) => void
  setInstalling: (progress: InstallProgress | null) => void
  setBootstrapped: (bootstrapped: boolean) => void
  launch: (id: string) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<void>
  setGraphics: (id: string, patch: Partial<GameGraphics>) => Promise<Game>
  setCompatibility: (id: string, patch: Partial<GameCompatibility>) => Promise<Game>
  clearShaderCache: (id: string) => Promise<ClearShaderCacheResult>
  setUpdate: (state: UpdateState) => void
  setUpdateOpen: (open: boolean) => void
  checkUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  /** Ask for release notes of an update installed by the last restart. */
  checkWhatsNew: () => Promise<void>
  dismissWhatsNew: () => Promise<void>
}

export const useLibrary = create<LibraryState>((set) => ({
  games: [],
  loading: true,
  appInfo: null,
  installing: null,
  selectedId: null,
  view: 'library',
  installOpen: false,
  bootstrapped: false,
  update: null,
  whatsNew: null,
  updateOpen: false,

  load: async () => {
    set({ loading: true })
    const games = await window.api.list()
    set({ games, loading: false })
  },

  refreshInfo: async () => {
    const appInfo = await window.api.appInfo()
    set({ appInfo })
  },

  scan: async () => {
    // Deliberately does not flip `loading` — the grid stays visible while a
    // scan runs; the button shows its own spinner.
    const result = await window.api.scan()
    set({ games: result.games })
    return result
  },

  select: (id) => set({ selectedId: id }),
  setView: (view) => set({ view, selectedId: null }),
  setInstallOpen: (installOpen) => set({ installOpen }),
  setInstalling: (installing) => set({ installing }),
  setBootstrapped: (bootstrapped) => set({ bootstrapped }),

  launch: async (id) => {
    const result = await window.api.launch(id)
    if (result.ok) {
      set((state) => ({
        games: state.games.map((game) => (game.id === id ? { ...game, lastPlayedAt: Date.now() } : game))
      }))
    }
    return result
  },

  remove: async (id) => {
    await window.api.remove(id)
    set((state) => ({
      games: state.games.filter((game) => game.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
      view: state.selectedId === id ? 'library' : state.view
    }))
  },

  setGraphics: async (id, patch) => {
    const updated = await graphicsApi().setGameGraphics(id, patch)
    set((state) => ({
      games: state.games.map((game) => (game.id === id ? updated : game))
    }))
    return updated
  },

  setCompatibility: async (id, patch) => {
    const updated = await graphicsApi().setGameCompatibility(id, patch)
    set((state) => ({
      games: state.games.map((game) => (game.id === id ? updated : game))
    }))
    return updated
  },

  clearShaderCache: (id) => graphicsApi().clearShaderCache(id),

  setUpdate: (update) => set({ update }),
  setUpdateOpen: (updateOpen) => set({ updateOpen }),

  checkUpdates: async () => {
    const update = await window.api.checkForUpdates()
    set({ update })
  },

  installUpdate: async () => {
    await window.api.installUpdate()
  },

  checkWhatsNew: async () => {
    const whatsNew = await window.api.whatsNew()
    if (whatsNew) set({ whatsNew })
  },

  dismissWhatsNew: async () => {
    await window.api.dismissWhatsNew()
    set({ whatsNew: null })
  }
}))

export function selectedGame(): Game | undefined {
  const { games, selectedId } = useLibrary.getState()
  return games.find((game) => game.id === selectedId)
}
