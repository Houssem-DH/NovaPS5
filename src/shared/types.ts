// Shared between the Electron main process, preload bridge, and renderer.

export type GameStatus = 'ready' | 'error'

export interface Game {
  id: string
  name: string
  titleId: string | null
  /** Original dump the game was installed from (kept for reference). */
  sourcePath: string
  /** Absolute path of the installed game folder (contains the exe + app0). */
  installPath: string
  /** Absolute path of the converted Windows executable. */
  exePath: string
  /** Size of installed content in bytes. */
  sizeBytes: number
  /** Relative (to installPath) cover image, e.g. "cover.png". */
  cover: string | null
  status: GameStatus
  error?: string
  installedAt: number
  lastPlayedAt?: number
}

export interface LibraryData {
  games: Game[]
}

export type InstallStep =
  | 'validating'
  | 'preparing'
  | 'copying'
  | 'unwrapping-eboot'
  | 'preparing-modules'
  | 'relinking'
  | 'building-layout'
  | 'finalizing'
  | 'done'

export type InstallStatus = 'running' | 'done' | 'error'

export interface InstallProgress {
  jobId: string
  step: InstallStep
  /** Human-readable description of what is happening right now. */
  message: string
  /** 0..100 */
  percent: number
  status: InstallStatus
  gameId?: string
  gameName?: string
  error?: string
}

export interface ImportRequest {
  /** Path to a dump folder, or a .zip containing one. */
  sourcePath: string
  /** Optional override for the display name. */
  name?: string
}

export interface DetectResult {
  isDump: boolean
  /** Set when isDump is true. */
  name?: string
  titleId?: string | null
  hasCover?: boolean
  /** Estimated content size in bytes (data + sce_sys + eboot), best-effort. */
  sizeBytes?: number
  reason?: string
}

export interface Settings {
  libraryRoot: string
  pythonPath: string | null
}

export interface AppInfo {
  toolsDir: string
  relinkerPresent: boolean
  libsPresent: boolean
  pythonPath: string | null
  libraryRoot: string
}

/** API exposed on window.api via the preload contextBridge. */
export interface LibraryApi {
  appInfo: () => Promise<AppInfo>
  selectFolder: () => Promise<string | null>
  selectArchive: () => Promise<string | null>
  detect: (sourcePath: string) => Promise<DetectResult>
  list: () => Promise<Game[]>
  install: (req: ImportRequest) => Promise<{ jobId: string }>
  launch: (id: string) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<{ ok: boolean }>
  onInstallProgress: (cb: (p: InstallProgress) => void) => () => void
  coverUrl: (game: Game) => string | null
}
