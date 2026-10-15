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
  /** Post-install launch test outcome ('works' | 'failed'), untested when absent. */
  launchState?: 'works' | 'failed'
  /** Human-readable detail from the launch test (exit code, fault info). */
  launchDetail?: string
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
  | 'launch-test'
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
  /** Post-install launch test outcome (set on the done report). */
  launchState?: 'works' | 'failed'
  launchDetail?: string
}

export interface ImportRequest {
  /** Path to a dump folder, or a .zip/.rar/.7z archive containing one. */
  sourcePath: string
  /** Optional override for the display name. */
  name?: string
}

// ---- Compatibility ----------------------------------------------------------

export type CompatStatus = 'pass' | 'warn' | 'fail'

export interface CompatCheck {
  id: string
  /** Short display name, e.g. "Executable", "Modules". */
  label: string
  status: CompatStatus
  /** One-line human explanation. */
  detail: string
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
  /** Compatibility report — present when isDump is true. */
  checks?: CompatCheck[]
  /** True when no check failed; installation should stay disabled otherwise. */
  compatible?: boolean
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
  /** True when the interpreter ships with the app (no system Python needed). */
  pythonBundled: boolean
  libraryRoot: string
  /** Absolute path of the folder where new games are installed. */
  gamesDir: string
  /** Version of the installed conversion runtime, null when never installed. */
  runtimeVersion: string | null
  /** "owner/repo" queried for runtime releases. */
  runtimeRepo: string
}

// ---- First-run bootstrap / runtime updates --------------------------------

export interface RuntimeManifest {
  version: string
  installedAt: number
  source: string
}

export type BootstrapStepId = 'check' | 'download' | 'extract' | 'install' | 'ready'

export type BootstrapStepStatus = 'pending' | 'active' | 'done' | 'warn' | 'error'

export interface BootstrapStep {
  id: BootstrapStepId
  label: string
  status: BootstrapStepStatus
  /** 0..100 download progress. */
  percent?: number
  detail?: string
}

export interface BootstrapResult {
  ok: boolean
  /** Installed runtime version after the run (null when nothing installed). */
  runtimeVersion: string | null
  /** True when a new runtime was downloaded and installed. */
  updated: boolean
  error?: string
}

// ---- Settings -------------------------------------------------------------

export interface AppSettings {
  /** Custom games folder, null = default (<libraryRoot>/games). */
  gamesDir: string | null
  runtimeRepo: string
}

export interface SetGamesDirResult {
  ok: boolean
  moved: number
  error?: string
}

/** What a library scan changed, so the UI can report it. */
export interface LibraryScanSummary {
  added: number
  missing: number
  repaired: number
}

export interface LibraryScanResult {
  games: Game[]
  summary: LibraryScanSummary
}

/** API exposed on window.api via the preload contextBridge. */
export interface LibraryApi {
  appInfo: () => Promise<AppInfo>
  selectFolder: () => Promise<string | null>
  selectArchive: () => Promise<string | null>
  detect: (sourcePath: string) => Promise<DetectResult>
  list: () => Promise<Game[]>
  /** Re-read the library from disk and adopt installs missing from the index. */
  scan: () => Promise<LibraryScanResult>
  install: (req: ImportRequest) => Promise<{ jobId: string }>
  launch: (id: string) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<{ ok: boolean }>
  onInstallProgress: (cb: (p: InstallProgress) => void) => () => void
  coverUrl: (game: Game) => string | null

  /** Check for a runtime release and install it when missing/outdated. */
  runBootstrap: () => Promise<BootstrapResult>
  /** Streamed checklist progress while runBootstrap is executing. */
  onBootstrapStep: (cb: (step: BootstrapStep) => void) => () => void
  /** The tray / app menu asks the UI to open the install dialog. */
  onOpenInstall: (cb: () => void) => () => void
  getSettings: () => Promise<AppSettings>
  /** Point new installs at another folder, relocating installed games. */
  setGamesDir: (dir: string) => Promise<SetGamesDirResult>
}
