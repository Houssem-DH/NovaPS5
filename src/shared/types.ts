// Shared between the Electron main process, preload bridge, and renderer.

export type GameStatus = 'ready' | 'error'

/** AnyPS5 swapchain present mode (ANYPS5_PRESENT_MODE). */
export type PresentMode = 'fifo' | 'fifo_latest_ready' | 'mailbox' | 'immediate'

/** Corner used by the AnyPS5 performance overlay (ANYPS5_OVERLAY_POS). */
export type OverlayPosition = 'tl' | 'tr' | 'bl' | 'br'

/**
 * Per-game AnyPS5 runtime settings applied when NovaPS5 starts the game.
 * These are the real controls the runtime exposes; the game itself still
 * chooses its render resolution and any FSR/DLSS mode.
 */
export interface GameGraphics {
  presentMode: PresentMode
  /** Part of a Vulkan device name, or null to let AnyPS5 choose. */
  gpu: string | null
  overlay: boolean
  overlayPosition: OverlayPosition
  /** False sets ANYPS5_NO_SHADER_CACHE=1. */
  shaderCache: boolean
  /** True sets APS5_PROFILE_GPU=1 so the overlay can show GPU time. */
  gpuProfile: boolean
  /** True sets APS5_PROFILE_DRAW=1 so the overlay can show driver time. */
  drawProfile: boolean
  /** True sets APS5_VIDEOOUT_TELEMETRY_DIR for the NovaPS5 session monitor. */
  telemetry: boolean
}

export const DEFAULT_GAME_GRAPHICS: GameGraphics = {
  presentMode: 'fifo',
  gpu: null,
  overlay: false,
  overlayPosition: 'tl',
  shaderCache: true,
  gpuProfile: false,
  drawProfile: false,
  telemetry: true
}

/**
 * Clamp persisted or hand-edited settings to values AnyPS5 understands. The
 * runtime rejects an unknown present mode/overlay corner, so a stale library
 * entry must not be able to break every launch of that game.
 */
export function normalizeGameGraphics(value?: Partial<GameGraphics> | null): GameGraphics {
  const presentMode: PresentMode =
    value?.presentMode === 'fifo' ||
    value?.presentMode === 'fifo_latest_ready' ||
    value?.presentMode === 'mailbox' ||
    value?.presentMode === 'immediate'
      ? value.presentMode
      : DEFAULT_GAME_GRAPHICS.presentMode

  const overlayPosition: OverlayPosition =
    value?.overlayPosition === 'tl' ||
    value?.overlayPosition === 'tr' ||
    value?.overlayPosition === 'bl' ||
    value?.overlayPosition === 'br'
      ? value.overlayPosition
      : DEFAULT_GAME_GRAPHICS.overlayPosition

  return {
    presentMode,
    gpu: typeof value?.gpu === 'string' && value.gpu.trim() ? value.gpu.trim() : null,
    overlay: value?.overlay === true,
    overlayPosition,
    shaderCache: value?.shaderCache !== false,
    gpuProfile: value?.gpuProfile === true,
    drawProfile: value?.drawProfile === true,
    telemetry: value?.telemetry !== false
  }
}

/**
 * How NovaPS5 feeds the game's `app0/sce_sys/trophy2/*.ucp` to AnyPS5.
 *
 * `package` uses the title's own trophy data. AnyPS5 0.1.3 throws from
 * `sceNpTrophy2GetTrophyInfo` when a title probes a trophy id the package does
 * not define, which aborts the guest process; a missing package makes the same
 * runtime answer with placeholders and return success instead.
 */
export type TrophyDataMode = 'package' | 'placeholders'

export interface GameCompatibility {
  trophyData: TrophyDataMode
}

export const DEFAULT_GAME_COMPATIBILITY: GameCompatibility = { trophyData: 'package' }

export function normalizeGameCompatibility(
  value?: Partial<GameCompatibility> | null
): GameCompatibility {
  return {
    trophyData: value?.trophyData === 'placeholders' ? 'placeholders' : 'package'
  }
}

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
  /** Per-game runtime settings applied before launch. Absent = defaults. */
  graphics?: GameGraphics
  /** Per-game workarounds for runtime behaviour that aborts a title. */
  compatibility?: GameCompatibility
}

export interface LibraryData {
  games: Game[]
}

export interface ClearShaderCacheResult {
  ok: boolean
  freedBytes?: number
  error?: string
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
  /**
   * True when conversion could not produce an executable at all. The game is
   * still registered (kept for retry) but has nothing to launch.
   */
  conversionFailed?: boolean
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
  /** Version of this app (from package.json). */
  appVersion: string
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
  /** "owner/repo" of this app, used for its release notes and links. */
  appRepo: string
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

// ---- Application updates ---------------------------------------------------

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Version currently running. */
  currentVersion: string
  /** Version offered by the update, when one was found. */
  version?: string
  /** 0..100 while downloading. */
  percent?: number
  /** Release notes (Markdown) for the offered/installed version. */
  notes?: string
  /** Short line for the header. */
  message?: string
  /** Longer explanation for the error state. */
  detail?: string
  /** True when the user asked for this check (enables "up to date" feedback). */
  manual?: boolean
}

/** Release notes of an update that was installed, shown once after restart. */
export interface WhatsNew {
  version: string
  /** Version the update was installed from, best effort. */
  from?: string
  notes: string
}

// ---- Store -----------------------------------------------------------------

/** Where a store entry's metadata came from. */
export type StoreSource = 'psn' | 'catalog'

export interface StoreGame {
  /** Stable key, e.g. "psn:UP9000-PPSA21564_00-…" or "catalog:my-game". */
  id: string
  source: StoreSource
  name: string
  /** PS5 title id derived from the product id (e.g. "PPSA21564"). */
  titleId: string | null
  publisher: string | null
  genres: string[]
  /** ISO date, best effort. */
  releaseDate: string | null
  /** Box art (type 10 image) — an https or embedded data URL. */
  coverUrl: string | null
  /** Wide hero art (type 12/13 image) — an https or embedded data URL. */
  heroUrl: string | null
  /** Installed size of the PS5 package, when the store exposes it. */
  sizeBytes: number | null
  /**
   * Download URL for a game the user hosts themselves (self-hosted catalog or
   * an attached URL). PS Store metadata entries never carry this — NovaPS5
   * does not download game content from Sony or third-party game sources.
   */
  downloadUrl: string | null
  /** Optional SHA-256 of the archive, verified before installing. */
  sha256: string | null
  /** Canonical PlayStation Store listing, for reference. */
  storeUrl: string | null
}

export interface StoreSearchQuery {
  text?: string
  /** PS Store genre key, e.g. "action". */
  genre?: string
  offset?: number
  size?: number
}

export interface StoreSearchResult {
  games: StoreGame[]
  /** Total matches known to the source (may exceed the returned page). */
  total: number
  offset: number
  size: number
  hasMore: boolean
  /** Region the page was fetched for. */
  region: string
  /** Non-fatal issue, e.g. the PS Store could not be reached. */
  error?: string
}

export interface StoreRegion {
  code: string
  language: string
  label: string
}

export interface StoreSettings {
  /** PS Store region, e.g. "GB". */
  region: string
  /** PS Store language, e.g. "en". */
  language: string
  /** Optional self-hosted catalog (https URL or a local file path). */
  catalogUrl: string | null
}

export type StoreEntryStatus = 'wishlist' | 'downloading' | 'downloaded' | 'installed'

/** A game the user added to their store library. */
export interface StoreEntry {
  game: StoreGame
  addedAt: number
  status: StoreEntryStatus
  /** Reserved for a local archive path; not used by the current pipeline. */
  localPath?: string
  /** Library id of the installed game, when status is "installed". */
  installedGameId?: string
}

export type StoreDownloadStep =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'done'
  | 'error'

export interface StoreDownloadProgress {
  jobId: string
  gameId: string
  gameName: string
  step: StoreDownloadStep
  message: string
  /** 0..100 across download + install. */
  percent: number
  receivedBytes?: number
  totalBytes?: number
  status: 'running' | 'done' | 'error'
  error?: string
  installedGameId?: string
}

/** An active or most-recent AnyPS5 run, as observed by NovaPS5. */
export interface GameSessionSample {
  /** Runtime steady-clock timestamp in milliseconds (ordering only). */
  t: number
  fps: number
}

export interface GameSession {
  active: boolean
  pid?: number
  startedAt?: number
  endedAt?: number
  /** False when telemetry was disabled or the runtime could not open it. */
  telemetry: boolean
  /** Newest last; the runtime emits one sample every 30 presented frames. */
  samples: GameSessionSample[]
  /** Number of telemetry samples the runtime had to drop. */
  dropped: number
  /** Wall-clock time the sample list last grew. */
  lastSampleAt?: number
}

/**
 * What the installed game's own metadata says about high-frame-rate output.
 * AnyPS5 only lets a title request its 119.88 Hz output mode when the display
 * is 120 Hz or faster AND the title's `attribute3` has bit 0x40 set; otherwise
 * the runtime's vblank/flip clock stays at 59.94 Hz.
 */
export interface GamePerformanceProfile {
  /** `attribute3` from app0/sce_sys/param.json, null when it cannot be read. */
  attribute3: number | null
  /** True when the 120 Hz output flag is set; null when metadata is unreadable. */
  highFrameRate: boolean | null
  /** Metadata file the value came from, or "none" when none could be read. */
  source: 'param.json' | 'none'
  /** Why the value is unknown, when it is. */
  detail?: string
}

/** A host display reported by Electron; used for read-only refresh info. */
export interface DisplayInfo {
  id: number
  label: string
  /** Physical pixels. */
  width: number
  height: number
  /** Hz as reported by the OS. */
  refreshRate: number
  scaleFactor: number
  primary: boolean
}

/** One trophy set file in app0/sce_sys/trophy2, as the runtime sees it. */
export interface TrophyPackageFile {
  /** File name on disk, e.g. trophy00.ucp or trophy00.ucp.disabled. */
  file: string
  /** Name the runtime opens, e.g. trophy00.ucp. */
  packageName: string
  /** True when NovaPS5 hid this file for the placeholder workaround. */
  disabled: boolean
  sizeBytes: number
  /** Trophy definitions in tropconf.json, null when the file cannot be read. */
  trophyCount: number | null
  /** First/last trophy id as written in the package (e.g. "0000"–"0034"). */
  idRange: [string, string] | null
}

export interface TrophyPackageInfo {
  /** Absolute path of app0/sce_sys/trophy2. */
  dir: string
  files: TrophyPackageFile[]
  /** Set when the folder or a package could not be read. */
  error?: string
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
  /** Host displays and their refresh rates (read-only). */
  displays: () => Promise<DisplayInfo[]>
  /** Live metrics for a game's current or most recent run. */
  session: (id: string) => Promise<GameSession>
  /** The game's own 120 Hz output flag, read from its installed metadata. */
  performance: (id: string) => Promise<GamePerformanceProfile>
  /** Merge per-game AnyPS5 runtime settings and return the saved game. */
  setGameGraphics: (id: string, patch: Partial<GameGraphics>) => Promise<Game>
  /** Merge per-game compatibility workarounds and apply them on disk. */
  setGameCompatibility: (id: string, patch: Partial<GameCompatibility>) => Promise<Game>
  /** The game's trophy2 packages and whether NovaPS5 hid them. */
  trophyPackage: (id: string) => Promise<TrophyPackageInfo>
  /** Delete the game's shader/pipeline cache (safe; rebuilt on next launch). */
  clearShaderCache: (id: string) => Promise<ClearShaderCacheResult>
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

  /** Current app-update status (also pushed on update:state). */
  updateState: () => Promise<UpdateState>
  /** Ask GitHub whether a newer NovaPS5 release exists. */
  checkForUpdates: () => Promise<UpdateState>
  /** Restart into an update that has finished downloading. */
  installUpdate: () => Promise<{ ok: boolean }>
  onUpdateState: (cb: (state: UpdateState) => void) => () => void
  /** Release notes of the update installed by the last restart, once. */
  whatsNew: () => Promise<WhatsNew | null>
  /** Mark the "what's new" notice as seen. */
  dismissWhatsNew: () => Promise<void>
  /** Open an http(s) link in the user's browser. */
  openExternal: (url: string) => Promise<void>
  /** Open the Windows display settings page (refresh-rate fix). */
  openDisplaySettings: () => Promise<void>

  // ---- Store ----------------------------------------------------------------
  /** Regions the store UI offers. */
  storeRegions: () => Promise<StoreRegion[]>
  storeSettings: () => Promise<StoreSettings>
  /** Change the region or the self-hosted catalog source. */
  storeSetSettings: (patch: Partial<StoreSettings>) => Promise<StoreSettings>
  /** Browse the catalog (PS Store metadata + the user's own catalog). */
  storeBrowse: (query?: StoreSearchQuery) => Promise<StoreSearchResult>
  /** Search by title. */
  storeSearch: (query: StoreSearchQuery) => Promise<StoreSearchResult>
  /** Hand-picked featured titles for the store's hero area. */
  storeFeatured: () => Promise<StoreGame[]>
  /** Games the user added to their store library. */
  storeLibrary: () => Promise<StoreEntry[]>
  storeAdd: (game: StoreGame) => Promise<StoreEntry[]>
  storeRemove: (id: string) => Promise<StoreEntry[]>
  /** Attach (or clear) a download URL for a game the user hosts themselves. */
  storeSetDownload: (id: string, url: string | null) => Promise<StoreEntry[]>

  /** Download a self-hosted archive, then convert and install it. */
  storeDownload: (id: string, url?: string) => Promise<{ jobId: string }>
  /** Convert and install a local dump/archive already on disk. */
  storeInstallLocal: (id: string, sourcePath: string) => Promise<{ jobId: string }>
  storeCancelDownload: (jobId: string) => Promise<{ ok: boolean }>
  onStoreProgress: (cb: (progress: StoreDownloadProgress) => void) => () => void
}
