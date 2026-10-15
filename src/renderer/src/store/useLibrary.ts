import { create } from 'zustand'
import type { AppInfo, Game, InstallProgress, LibraryScanResult, UpdateState, WhatsNew } from '@shared/types'

export type View = 'library' | 'settings'

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
  setUpdate: (state: UpdateState) => void
  setUpdateOpen: (open: boolean) => void
  checkUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  /** Ask for release notes of an update installed by the last restart. */
  checkWhatsNew: () => Promise<void>
  dismissWhatsNew: () => Promise<void>
}

export const useLibrary = create<LibraryState>((set, get) => ({
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
    void get()
  },

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
