import { create } from 'zustand'
import type { AppInfo, Game, InstallProgress } from '@shared/types'

export type View = 'library' | 'settings'

interface LibraryState {
  games: Game[]
  loading: boolean
  appInfo: AppInfo | null
  installing: InstallProgress | null
  selectedId: string | null
  view: View
  installOpen: boolean

  load: () => Promise<void>
  refreshInfo: () => Promise<void>
  select: (id: string | null) => void
  setView: (view: View) => void
  setInstallOpen: (open: boolean) => void
  setInstalling: (progress: InstallProgress | null) => void
  launch: (id: string) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<void>
}

export const useLibrary = create<LibraryState>((set, get) => ({
  games: [],
  loading: true,
  appInfo: null,
  installing: null,
  selectedId: null,
  view: 'library',
  installOpen: false,

  load: async () => {
    set({ loading: true })
    const games = await window.api.list()
    set({ games, loading: false })
  },

  refreshInfo: async () => {
    const appInfo = await window.api.appInfo()
    set({ appInfo })
  },

  select: (id) => set({ selectedId: id }),
  setView: (view) => set({ view, selectedId: null }),
  setInstallOpen: (installOpen) => set({ installOpen }),
  setInstalling: (installing) => set({ installing }),

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
  }
}))

export function selectedGame(): Game | undefined {
  const { games, selectedId } = useLibrary.getState()
  return games.find((game) => game.id === selectedId)
}
