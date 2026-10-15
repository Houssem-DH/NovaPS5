import { contextBridge, ipcRenderer } from 'electron'
import type { BootstrapStep, Game, ImportRequest, InstallProgress, LibraryApi } from '@shared/types'

const api: LibraryApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectArchive: () => ipcRenderer.invoke('dialog:selectZip'),
  detect: (sourcePath: string) => ipcRenderer.invoke('library:detect', sourcePath),
  list: () => ipcRenderer.invoke('library:list'),
  install: (req: ImportRequest) => ipcRenderer.invoke('install:start', req),
  launch: (id: string) => ipcRenderer.invoke('game:launch', id),
  remove: (id: string) => ipcRenderer.invoke('game:remove', id),
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
  setGamesDir: (dir: string) => ipcRenderer.invoke('settings:setGamesDir', dir)
}

contextBridge.exposeInMainWorld('api', api)
