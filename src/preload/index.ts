import { contextBridge, ipcRenderer } from 'electron'
import type {
  BootstrapStep,
  Game,
  GameCompatibility,
  GameGraphics,
  ImportRequest,
  InstallProgress,
  LibraryApi,
  StoreDownloadProgress,
  StoreGame,
  StoreSearchQuery,
  StoreSettings,
  UpdateState
} from '@shared/types'

const api: LibraryApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  displays: () => ipcRenderer.invoke('app:displays'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectArchive: () => ipcRenderer.invoke('dialog:selectZip'),
  detect: (sourcePath: string) => ipcRenderer.invoke('library:detect', sourcePath),
  list: () => ipcRenderer.invoke('library:list'),
  scan: () => ipcRenderer.invoke('library:scan'),
  install: (req: ImportRequest) => ipcRenderer.invoke('install:start', req),
  launch: (id: string) => ipcRenderer.invoke('game:launch', id),
  session: (id: string) => ipcRenderer.invoke('game:session', id),
  performance: (id: string) => ipcRenderer.invoke('game:performance', id),
  remove: (id: string) => ipcRenderer.invoke('game:remove', id),
  setGameGraphics: (id: string, patch: Partial<GameGraphics>) =>
    ipcRenderer.invoke('game:setGraphics', id, patch),
  setGameCompatibility: (id: string, patch: Partial<GameCompatibility>) =>
    ipcRenderer.invoke('game:setCompatibility', id, patch),
  trophyPackage: (id: string) => ipcRenderer.invoke('game:trophyPackage', id),
  clearShaderCache: (id: string) => ipcRenderer.invoke('game:clearShaderCache', id),
  onInstallProgress: (cb: (progress: InstallProgress) => void) => {
    const listener = (_event: unknown, progress: InstallProgress): void => cb(progress)
    ipcRenderer.on('install:progress', listener)
    return () => ipcRenderer.removeListener('install:progress', listener)
  },
  coverUrl: (game: Game) => (game.cover ? `media://library/${game.id}/${game.cover}` : null),

  runBootstrap: () => ipcRenderer.invoke('bootstrap:run'),
  onBootstrapStep: (cb: (step: BootstrapStep) => void) => {
    const listener = (_event: unknown, step: BootstrapStep): void => cb(step)
    ipcRenderer.on('bootstrap:step', listener)
    return () => ipcRenderer.removeListener('bootstrap:step', listener)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setGamesDir: (dir: string) => ipcRenderer.invoke('settings:setGamesDir', dir),
  onOpenInstall: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ui:install', listener)
    return () => ipcRenderer.removeListener('ui:install', listener)
  },

  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb: (state: UpdateState) => void) => {
    const listener = (_event: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
  whatsNew: () => ipcRenderer.invoke('update:whatsNew'),
  dismissWhatsNew: () => ipcRenderer.invoke('update:dismissWhatsNew'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  openDisplaySettings: () => ipcRenderer.invoke('app:openDisplaySettings'),

  // ---- Store ----------------------------------------------------------------
  storeRegions: () => ipcRenderer.invoke('store:regions'),
  storeSettings: () => ipcRenderer.invoke('store:settings:get'),
  storeSetSettings: (patch: Partial<StoreSettings>) =>
    ipcRenderer.invoke('store:settings:set', patch),
  storeBrowse: (query?: StoreSearchQuery) => ipcRenderer.invoke('store:browse', query),
  storeSearch: (query: StoreSearchQuery) => ipcRenderer.invoke('store:search', query),
  storeFeatured: () => ipcRenderer.invoke('store:featured'),
  storeLibrary: () => ipcRenderer.invoke('store:library:list'),
  storeAdd: (game: StoreGame) => ipcRenderer.invoke('store:add', game),
  storeRemove: (id: string) => ipcRenderer.invoke('store:remove', id),
  storeSetDownload: (id: string, url: string | null) =>
    ipcRenderer.invoke('store:setDownload', id, url),
  storeDownload: (id: string, url?: string) => ipcRenderer.invoke('store:download', id, url),
  storeInstallLocal: (id: string, sourcePath: string) =>
    ipcRenderer.invoke('store:installLocal', id, sourcePath),
  storeCancelDownload: (jobId: string) => ipcRenderer.invoke('store:cancel', jobId),
  onStoreProgress: (cb: (progress: StoreDownloadProgress) => void) => {
    const listener = (_event: unknown, progress: StoreDownloadProgress): void => cb(progress)
    ipcRenderer.on('store:progress', listener)
    return () => ipcRenderer.removeListener('store:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
