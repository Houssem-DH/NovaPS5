import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { gamesRoot, ensureDir } from '../paths'
import { detectContainer, readElfDynamicInfo } from './elf'
import { unwrapSelf } from './unwrap'
import { relink, RelinkError, type RelinkResult } from './relink'
import { copyDir, dirSize } from './copy'
import { buildLayout } from './layout'
import { resolveSource, readMeta, sourceFallbackName } from './dump'
import {
  checkCompatibility,
  formatBlockers,
  discoverModuleFiles,
  isBackupName,
  moduleDirRank,
  type ModuleCandidate
} from './compat'
import { probeLaunch, type LaunchProbe } from './verify'
import { addGame, getGame, slugify } from '../library'
import { setTrophyDataMode } from '../trophy'
import type {
  Game,
  GameCompatibility,
  InstallProgress,
  InstallStep
} from '@shared/types'

// Skip leftover unwrap backups — the original SELF is not needed at runtime
// and a duplicate ELF next to its real module would collide by SONAME.
function isBackup(name: string): boolean {
  return name.endsWith('.esbak')
}

/**
 * Relinker progress stage → [start percent, span]. The converter reports 0–100
 * independently for each stage, so each stage gets its own slice of the
 * install's 68–88% range to keep the overall bar moving forward.
 */
const RELINK_PROGRESS: Record<string, [number, number]> = {
  Executable: [68, 1],
  'Syscall scan': [70, 3],
  'Instruction scan': [73, 3],
  'Instruction conversion': [68, 2],
  'Import analysis': [79, 1],
  'PRX conversion': [80, 5],
  'Output image': [85, 2],
  'Write output': [87, 1]
}

/** Free bytes on the volume that holds `dir`, or null when it cannot be read. */
async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir)
    // bavail can legitimately be 0 on some Windows filesystems while bfree is
    // still meaningful — prefer whichever reports space.
    const available = Number(stats.bavail || stats.bfree || 0) * Number(stats.bsize || 0)
    return Number.isFinite(available) && available > 0 ? available : null
  } catch {
    return null
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Pick the module files a relinker failure points at. The relinker mentions
 * module filenames, SONAMEs, module paths and `Input:` paths; matching those
 * against the surviving modules lets a retry drop only what actually broke.
 * The `.guest.prx` suffix is stripped because that is the *output* name, not
 * the source module's filename.
 */
function identifyOffendingModules(
  detail: string,
  output: string,
  modules: ModuleCandidate[],
  sonames: Map<ModuleCandidate, string | null>
): string[] {
  // Only the failure line and `Input:` line are trustworthy: normal progress
  // output can mention every module, which would exclude the whole set.
  const inputLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^Input:/i.test(line))
  const haystack = `${detail}\n${inputLines.join('\n')}`.toLowerCase()
  const found = new Set<string>()
  for (const file of modules) {
    const name = file.name.toLowerCase()
    if (name.length >= 4 && haystack.includes(name)) found.add(file.name)
    const soname = sonames.get(file)?.toLowerCase()
    if (soname && soname.length >= 4 && haystack.includes(soname)) found.add(file.name)
  }
  for (const match of haystack.matchAll(/([^\s"'\\/]+?)\.guest\.prx/g)) {
    const base = match[1]
    const hit = modules.find((file) => file.name.toLowerCase() === base)
    if (hit) found.add(hit.name)
  }
  return [...found]
}

// Staging folders still being written by a running install — guards the
// orphan sweep below from deleting a concurrent run's folder.
const activeStages = new Set<string>()

/**
 * The full hands-off conversion pipeline:
 *   validate -> copy -> unwrap eboot -> prepare modules -> relink -> layout -> register.
 * Progress is reported through `report`; errors are also reported then rethrown.
 */
export async function installGame(
  sourcePath: string,
  nameOverride: string | undefined,
  report: (p: InstallProgress) => void,
  jobId: string
): Promise<Game> {
  let step: InstallStep = 'validating'
  let percent = 0
  let tempDir: string | null = null
  // The pipeline builds into a staging folder and swaps it into place only
  // after every step has succeeded — a failed re-install therefore never
  // destroys the previously working copy. Tracked outside the try/catch so
  // a failed run cleans up its own partial folder.
  let stageDir: string | null = null

  // State recorded once the dump has been copied. If conversion then fails,
  // the game is still registered as "Not working" so no dump is ever lost.
  let id = ''
  let name = ''
  let metaTitleId: string | null = null
  let persistentSource = ''
  let finalDir = ''
  let exeName = ''
  // 'pre' (validation/copy) → 'converting' (unwrap/relink/layout) →
  // 'converted'. Only a failure while 'converting' is registered best-effort.
  let phase: 'pre' | 'converting' | 'converted' = 'pre'

  const emit = (message: string, pct: number, s: InstallStep): void => {
    step = s
    // Keep the reported value an integer — it renders directly in the UI.
    percent = Math.round(pct)
    report({ jobId, step, message, percent, status: 'running' })
  }

  /**
   * Best-effort finish after the dump has been copied but conversion failed.
   * Keeps the copy as the install folder and registers the game as Not
   * working, so no dump is ever thrown away and a later retry can replace it.
   * Returns null when a previous install is still playable — that copy must
   * never be replaced by a broken one.
   */
  const registerFailed = async (reason: string): Promise<Game | null> => {
    const stage = stageDir
    if (!stage || !finalDir || !id || !name) return null

    const prior = await getGame(id)
    if (prior?.status === 'ready' && fs.existsSync(prior.exePath)) return null

    emit('Conversion failed — keeping the install for retry…', 92, 'finalizing')
    let retire = `${finalDir}.old`
    await fsp.rm(retire, { recursive: true, force: true }).catch(() => {})
    if (fs.existsSync(retire)) retire = `${finalDir}.old-${Date.now()}`
    if (fs.existsSync(finalDir)) await fsp.rename(finalDir, retire)
    try {
      await fsp.rename(stage, finalDir)
    } catch (swapError) {
      // Put the previous (failed) copy back rather than losing both.
      if (fs.existsSync(retire)) await fsp.rename(retire, finalDir).catch(() => {})
      throw swapError
    }
    await fsp.rm(retire, { recursive: true, force: true }).catch(() => {})
    activeStages.delete(path.basename(stage))
    stageDir = null
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      tempDir = null
    }

    const sizeBytes = await dirSize(finalDir)
    let cover: string | null = null
    for (const candidate of ['icon0.png', 'pic0.png', 'pic1.png']) {
      try {
        await fsp.copyFile(
          path.join(finalDir, 'sce_sys', candidate),
          path.join(finalDir, 'cover.png')
        )
        cover = 'cover.png'
        break
      } catch {
        try {
          await fsp.copyFile(
            path.join(finalDir, 'app0', 'sce_sys', candidate),
            path.join(finalDir, 'cover.png')
          )
          cover = 'cover.png'
          break
        } catch {
          /* try the next artwork file */
        }
      }
    }

    const detail =
      reason.trim().replace(/^Conversion failed\s*—\s*/i, '') ||
      'the converter could not produce an executable'
    const game: Game = {
      id,
      name,
      titleId: metaTitleId,
      sourcePath: persistentSource,
      installPath: finalDir,
      exePath: path.join(finalDir, exeName),
      sizeBytes,
      cover,
      status: 'error',
      error: `Conversion failed — ${detail}`,
      installedAt: Date.now(),
      launchState: 'failed',
      launchDetail: detail
    }
    await addGame(game)
    report({
      jobId,
      step: 'done',
      message: 'Installed — conversion failed, kept for retry',
      percent: 100,
      status: 'done',
      gameId: id,
      gameName: name,
      launchState: 'failed',
      launchDetail: detail,
      conversionFailed: true
    })
    return game
  }

  try {
    emit('Validating source…', 2, 'validating')
    const resolved = await resolveSource(sourcePath)
    tempDir = resolved.tempDir
    const dumpRoot = resolved.root
    // For archives, dumpRoot is a temp extraction folder that is deleted at
    // the end; keep the user's archive path in the library instead.
    persistentSource = resolved.tempDir ? sourcePath : dumpRoot

    if (!fs.existsSync(path.join(dumpRoot, 'eboot.bin'))) {
      throw new Error('No eboot.bin found — this does not look like a PS5 game dump.')
    }

    // ---- Compatibility test: fail fast with a clear report, before any copy
    emit('Checking compatibility…', 4, 'validating')
    const compat = await checkCompatibility(dumpRoot)
    const blockers = formatBlockers(compat)
    if (blockers) throw new Error(`Not compatible — ${blockers}`)

    const meta = await readMeta(dumpRoot)
    metaTitleId = meta.titleId
    const fallbackName =
      resolved.tempDir && meta.name === path.basename(dumpRoot)
        ? sourceFallbackName(sourcePath)
        : meta.name
    name = (nameOverride?.trim() || fallbackName).slice(0, 90)
    // Compute the output name now: a best-effort failed install records the
    // path the executable would have had, so a later retry/reinstall matches.
    let safeName = name.replace(/[\\/:*?"<>|]/g, '').trim() || 'game'
    // Windows reserves CON/PRN/AUX/NUL/COM1-9/LPT1-9 regardless of extension.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safeName)) safeName += '_'
    exeName = `${safeName}.exe`
    const baseId = slugify(name)

    // Pick an install dir:
    //  - re-installing the SAME title (matching titleId) replaces its folder;
    //  - a different title with the same display name, or an existing folder
    //    not owned by this title, gets a unique suffixed id so nothing else
    //    is ever overwritten.
    const owned = await getGame(baseId)
    // A prior failed conversion for the same name is a retry, not a second
    // copy — replace it even when the dump has no readable title ID.
    const sameTitle =
      !!owned &&
      ((!!meta.titleId && owned.titleId === meta.titleId) ||
        (owned.status === 'error' && owned.name === name))
    id = baseId
    if (!sameTitle) {
      let n = 2
      const taken = async (candidate: string): Promise<boolean> =>
        !!(await getGame(candidate)) || fs.existsSync(path.join(gamesRoot(), candidate))
      while (await taken(id)) id = `${baseId}-${n++}`
    }
    finalDir = path.join(gamesRoot(), id)
    const stageName = `.staging-${id}-${Date.now()}`
    const installDir = path.join(gamesRoot(), stageName)
    stageDir = installDir
    activeStages.add(stageName)
    // Sweep staging folders orphaned by a crashed run so they never pile up.
    for (const entry of await fsp.readdir(gamesRoot()).catch(() => [] as string[])) {
      if (entry.startsWith('.staging-') && !activeStages.has(entry)) {
        await fsp.rm(path.join(gamesRoot(), entry), { recursive: true, force: true }).catch(() => {})
      }
    }
    await fsp.rm(installDir, { recursive: true, force: true })
    ensureDir(installDir)

    // ---- Copy EVERYTHING in the dump root ----
    // Dumps differ: some keep game data under data/, others ship it at the root
    // (images/, media/, *.js, ...). Copying the whole tree keeps any layout
    // playable; only unwrap backups are skipped.
    const entries = (await fsp.readdir(dumpRoot, { withFileTypes: true })).filter(
      (entry) => !isBackup(entry.name) && !isBackupName(entry.name)
    )
    let total = 0
    for (const entry of entries) total += await dirSize(path.join(dumpRoot, entry.name))

    // Fail before a multi-gigabyte copy if the games volume cannot hold the
    // result. A re-install needs room for both the staging build and the old
    // copy that is parked during the swap, so account for it.
    const existingSize = fs.existsSync(finalDir) ? await dirSize(finalDir) : 0
    const free = await freeSpace(gamesRoot())
    if (free !== null && total > 0 && free < total + existingSize + 256 * 1024 * 1024) {
      throw new Error(
        `Not enough free space — this game needs about ${formatBytes(total + existingSize)} but only ${formatBytes(free)} is available on the games drive. Free some space and retry.`
      )
    }

    let copied = 0
    let lastCopyEmit = 0
    emit('Copying game data…', 8, 'copying')
    for (const entry of entries) {
      const src = path.join(dumpRoot, entry.name)
      const dest = path.join(installDir, entry.name)
      const tick = (n: number): void => {
        copied += n
        const pct = total > 0 ? 8 + Math.min(42, (copied / total) * 42) : 8
        // Throttle: dumps can hold thousands of small files (cover art, images)
        const now = Date.now()
        if (pct - percent >= 1 || now - lastCopyEmit > 400) {
          lastCopyEmit = now
          emit(`Copying ${entry.name}…`, pct, 'copying')
        }
      }
      if (entry.isDirectory()) {
        await copyDir(src, dest, tick)
        continue
      }
      // Files, symlinks and archive oddities alike are copied by content —
      // never skip an entry silently (a skipped file must not surface later
      // as a cryptic "corrupted dump" error).
      try {
        const followed = await fsp.stat(src) // follows symlinks
        if (followed.isDirectory()) {
          await copyDir(src, dest, tick)
        } else {
          // A top-level eboot.bin held by antivirus must not fail the install
          // on a transient Windows lock — retry the same way copyDir does.
          for (let attempt = 0; ; attempt++) {
            try {
              await fsp.copyFile(src, dest)
              tick(followed.size)
              break
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') break
              if (attempt < 2 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
                await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
                continue
              }
              throw error
            }
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // A broken/vanished entry at the dump root is harmless (copyDir
        // already skips these); anything else must name the exact file.
        if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') continue
        throw new Error(
          `Could not copy "${entry.name}" from the dump — ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    // Every remaining failure below leaves a complete copy of the dump on
    // disk, so a failed conversion can still be registered for retry.
    phase = 'converting'

    // ---- Unwrap the eboot (SELF -> ELF) ----
    const ebootDest = path.join(installDir, 'eboot.bin')
    const inputElf = path.join(installDir, 'input.elf')
    // The eboot is the one file the pipeline cannot proceed without: verify it
    // landed and re-copy it straight from the source if anything interfered.
    if (detectContainer(ebootDest) === 'unknown') {
      const sourceEboot = path.join(dumpRoot, 'eboot.bin')
      if (detectContainer(sourceEboot) !== 'unknown') {
        await fsp.copyFile(sourceEboot, ebootDest)
      }
    }
    const ebootKind = detectContainer(ebootDest)
    if (ebootKind === 'self') {
      emit('Unwrapping eboot (SELF → ELF)…', 55, 'unwrapping-eboot')
      await unwrapSelf(ebootDest, inputElf)
    } else if (ebootKind === 'elf') {
      // already a plain ELF — the relinker can read it directly
      await fsp.copyFile(ebootDest, inputElf)
    } else if (ebootKind === 'pe') {
      // The selected folder is an installed/already-converted build, not a
      // dump. Saying so avoids the old "module/executable is corrupted" loop.
      throw new Error(
        'eboot.bin is a Windows executable, not a PS5 dump — this folder looks already converted. Import the original dump folder instead.'
      )
    } else {
      // Never hand an unrecognized file to the relinker — it fails with a
      // cryptic conversion error instead of naming the real problem.
      throw new Error(
        'eboot.bin is neither a plain ELF nor a SELF container — the dump file is corrupted or incomplete.'
      )
    }

    // ---- Prepare bundled modules ----
    // The relinker treats ANY ELF/SELF file inside a module folder as a guest
    // module, extension ignored. Discover exactly what it will pick up — the
    // standard folders plus PS4 module folders (Media/Modules, Media/Plugins,
    // …) — then unwrap every SELF, prune backups, and reconcile duplicates
    // before the converter sees them.
    emit('Preparing modules…', 60, 'preparing-modules')

    // The relinker refuses to run when both folder spellings exist — merge
    // sce_modules/ into sce_module/ on the staging copy (name conflicts keep
    // the sce_module file) and drop the now-empty plural folder.
    const singularDir = path.join(installDir, 'sce_module')
    const pluralDir = path.join(installDir, 'sce_modules')
    if (fs.existsSync(singularDir) && fs.existsSync(pluralDir)) {
      for (const entry of await fsp.readdir(pluralDir, { withFileTypes: true })) {
        const from = path.join(pluralDir, entry.name)
        const to = path.join(singularDir, entry.name)
        if (fs.existsSync(to)) await fsp.rm(from, { recursive: true, force: true })
        else await fsp.rename(from, to)
      }
      await fsp.rm(pluralDir, { recursive: true, force: true })
    }

    // Re-discover after the merge: module paths may have changed.
    const modules = await discoverModuleFiles(installDir)

    // `fakelib`-style folders hold stand-in copies of the console's system
    // libraries. They are intentionally not converted: the runtime provides
    // real implementations, and the stubs' imports abort the entry point.
    if (modules.shims.length > 0) {
      const folders = [...new Set(modules.shims.map((file) => file.rel))].join(', ')
      console.info(
        `[install] leaving ${modules.shims.length} stand-in system librar${
          modules.shims.length === 1 ? 'y' : 'ies'
        } in ${folders} unconverted — the runtime provides its own implementations`
      )
    }

    // Names of modules the conversion had to drop. A failed launch test uses
    // this list to say "module X was skipped" instead of a bare fault code.
    const skippedModules: string[] = []

    // Previous conversion outputs (the converter's own Windows PE
    // `*.guest.prx` files), crashed-unwrap temp files, and backups are never
    // source modules. They are removed from the staging copy only; the source
    // dump is never modified. This is what prevents a re-imported or
    // pre-converted dump from feeding a PE back into module validation.
    for (const rel of modules.leftovers) {
      await fsp.rm(path.join(installDir, rel), { force: true }).catch(() => {})
    }

    // Duplicate identities abort the relinker: two files with one filename
    // ("Conflicting guest output filename") or the same SONAME in different
    // folders ("Ambiguous guest module identity"). Keep the highest-ranked
    // copy (sce_module > sce_modules > prx > elsewhere) and drop the rest
    // from the staging copy only.
    //
    // Filename dedupe runs before unwrapping: the content is irrelevant to
    // the name, and unwrapping losing copies wastes time or fails on a broken
    // copy the converter would never use.
    const preferred = (
      candidate: ModuleCandidate,
      current: ModuleCandidate | undefined
    ): boolean => {
      if (!current) return true
      const rank = moduleDirRank(candidate.rel) - moduleDirRank(current.rel)
      if (rank !== 0) return rank < 0
      if (candidate.rel !== current.rel) return candidate.rel < current.rel
      // Prefer the shorter name at equal rank: `foo.prx` beats an infix
      // backup like `foo.bak.prx` when both declare the same SONAME.
      if (candidate.name.length !== current.name.length) {
        return candidate.name.length < current.name.length
      }
      return candidate.name.localeCompare(current.name) < 0
    }

    // The relinker cannot emit a Windows file for these names and would abort
    // the whole conversion. Drop only those modules: the rest of the game can
    // still install, and the launch test explains any runtime consequence.
    const candidates: ModuleCandidate[] = []
    for (const file of modules.files) {
      if (!fs.existsSync(file.path)) continue
      if (/[^\x20-\x7e]|[:$]/.test(file.name)) {
        console.warn(`[install] skipping module with unsupported filename: ${file.rel}/${file.name}`)
        skippedModules.push(`${file.rel}/${file.name}`)
        await fsp.rm(file.path, { force: true }).catch(() => {})
        continue
      }
      candidates.push(file)
    }

    const byName = new Map<string, ModuleCandidate>()
    for (const file of candidates) {
      const key = file.name.toLowerCase()
      if (preferred(file, byName.get(key))) byName.set(key, file)
    }
    for (const file of candidates) {
      if (byName.get(file.name.toLowerCase()) !== file) {
        await fsp.rm(file.path, { force: true }).catch(() => {})
      }
    }

    // Unwrap every SELF module, whatever its filename. The relinker skips
    // SELF containers with a warning and would silently drop the module — the
    // crash only shows up after installation. A module that cannot be
    // unwrapped is dropped from the staging copy instead of aborting the whole
    // install: the user asked for best-effort installs, and the launch test
    // reports the consequence.
    const keptByName = candidates.filter((file) => fs.existsSync(file.path))
    for (const file of keptByName) {
      if (file.magic !== 'self') continue
      emit(`Unwrapping ${file.name}…`, 60, 'preparing-modules')
      try {
        await unwrapSelf(file.path, file.path)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[install] skipping module "${file.rel}/${file.name}" — ${detail}`)
        skippedModules.push(`${file.rel}/${file.name}`)
        await fsp.rm(file.path, { force: true }).catch(() => {})
      }
    }

    // The relinker also aborts when several surviving modules declare the same
    // SONAME, even if their filenames differ. Read the dynamic section after
    // unwrapping so this is reconciled before conversion, not as an error.
    const survivors = keptByName.filter((file) => fs.existsSync(file.path))
    const sonames = new Map<ModuleCandidate, string | null>()
    for (const file of survivors) {
      sonames.set(file, readElfDynamicInfo(file.path)?.soname ?? null)
    }
    const bySoname = new Map<string, ModuleCandidate>()
    for (const file of survivors) {
      const soname = sonames.get(file)
      if (!soname) continue
      const key = soname.toLowerCase()
      if (preferred(file, bySoname.get(key))) bySoname.set(key, file)
    }
    for (const file of survivors) {
      const soname = sonames.get(file)
      if (!soname) continue
      if (bySoname.get(soname.toLowerCase()) !== file) {
        await fsp.rm(file.path, { force: true }).catch(() => {})
      }
    }

    const moduleFiles = survivors.filter((file) => fs.existsSync(file.path))
    const moduleDirs = [...new Set(moduleFiles.map((file) => file.rel))]
      .filter((rel) => {
        const key = rel.replace(/\\/g, '/').toLowerCase()
        return key !== 'sce_module' && key !== 'sce_modules' && key !== 'prx'
      })
      .sort((a, b) => moduleDirRank(a) - moduleDirRank(b) || a.localeCompare(b))
    // The relinker requires at least one standard module folder to exist. A
    // dump that never shipped modules gets an empty sce_module/ instead of the
    // deprecated --skip-sce-module flag (upstream marks that flag unstable);
    // the converter simply finds no modules to carry over.
    const hasStandardDir = ['sce_module', 'sce_modules', 'prx'].some((dir) => {
      try {
        return fs.statSync(path.join(installDir, dir)).isDirectory()
      } catch {
        return false
      }
    })
    if (!hasStandardDir && moduleDirs.length === 0) {
      const target = path.join(installDir, 'sce_module')
      if (fs.existsSync(target)) {
        throw new Error(
          'A file named "sce_module" is in the way of the module folder — remove or rename it in the dump and retry.'
        )
      }
      await fsp.mkdir(target, { recursive: true })
    }
    const modDir = path.join(installDir, 'sce_module')

    // ---- Relink into a Windows executable ----
    emit('Converting to a Windows executable…', 68, 'relinking')
    const exePath = path.join(installDir, exeName)
    // The relinker draws its own progress with carriage returns. Mirror those
    // frames onto the 68–88% slice so the bar does not sit still for minutes.
    let relinkTail = ''
    let relinkMapped = 68
    const onRelinkOutput = (chunk: string): void => {
      const frames = (relinkTail + chunk).split(/[\r\n]/)
      relinkTail = frames.pop() ?? ''
      for (const frame of frames) {
        const match = frame.match(
          /(Executable|PRX conversion|Syscall scan|Instruction scan|Instruction conversion|Import analysis|Output image|Write output)\s*\|\s*[^|]*\|\s*(\d{1,3})%/
        )
        if (!match) continue
        const slice = RELINK_PROGRESS[match[1]]
        if (!slice) continue
        const [base, span] = slice
        const stagePercent = Math.min(100, Number(match[2]))
        const mapped = Math.min(88, base + (span * stagePercent) / 100)
        // Some stages can run in a different order depending on the target;
        // never let a late frame pull the bar backwards.
        relinkMapped = Math.max(relinkMapped, mapped)
        emit(`Converting — ${match[1].toLowerCase()} ${stagePercent}%`, relinkMapped, 'relinking')
      }
    }
    // cwd = installDir so the relinker writes app0/ next to the exe.
    // windowsDiagnostics embeds a startup report that names missing
    // dependencies instead of failing with a bare exception code.
    const runRelink = (excludeModules: string[] = []): Promise<RelinkResult> =>
      relink(inputElf, exePath, {
        cwd: installDir,
        moduleDirs,
        windowsDiagnostics: true,
        onOutput: onRelinkOutput,
        excludeModules
      })

    // A guest module can make the relinker abort (ambiguous exports, cyclic
    // initialization, unsupported symbols …). Retry without the offending
    // module first; if it cannot be identified, retry with no guest modules at
    // all. The game may not launch after that, but the install still completes
    // and the launch test explains the consequence.
    const relinkBestEffort = async (): Promise<RelinkResult> => {
      try {
        return await runRelink()
      } catch (error) {
        if (!(error instanceof RelinkError) || !/guest|module/i.test(error.detail)) throw error
        let lastError: unknown = error
        const names = identifyOffendingModules(error.detail, error.output, moduleFiles, sonames)
        if (names.length > 0) {
          emit(
            `Conversion failed — retrying without ${names.length === 1 ? names[0] : `${names.length} module files`}…`,
            68,
            'relinking'
          )
          for (const name of names) if (!skippedModules.includes(name)) skippedModules.push(name)
          try {
            return await runRelink(names)
          } catch (retryError) {
            if (!(retryError instanceof RelinkError)) throw retryError
            lastError = retryError
          }
        }
        const allNames = [...new Set(moduleFiles.map((file) => file.name))]
        const alreadyExcludedAll =
          names.length > 0 && allNames.every((name) => names.includes(name))
        if (allNames.length > 0 && !alreadyExcludedAll) {
          emit('Conversion failed — retrying without bundled modules…', 68, 'relinking')
          for (const name of allNames) if (!skippedModules.includes(name)) skippedModules.push(name)
          try {
            return await runRelink(allNames)
          } catch (retryError) {
            if (!(retryError instanceof RelinkError)) throw retryError
            lastError = retryError
          }
        }
        throw lastError
      }
    }
    const relinked = await relinkBestEffort()
    if (relinked.skippedSelf.length > 0) {
      // Should not happen (every discovered SELF was unwrapped above), but
      // never hide it: the launch test will explain the consequence.
      console.warn(
        `[install] relinker skipped SELF containers: ${relinked.skippedSelf.join(', ')}`
      )
    }

    // Exit code 0 is not proof of a usable build — verify the PE before
    // registering the game.
    if (!fs.existsSync(exePath)) {
      throw new Error(
        'Conversion finished without producing an executable — the dump is incomplete or the converter was interrupted. Retry the installation.'
      )
    }
    if (detectContainer(exePath) !== 'pe') {
      throw new Error(
        'Conversion produced a file that is not a Windows executable — the converter output is corrupted. Retry the installation.'
      )
    }

    // The raw module sources were consumed by the relinker — only the
    // converted *.guest.prx files belong in the final arrangement.
    for (const file of moduleFiles) {
      await fsp.rm(file.path, { force: true }).catch(() => {})
    }

    // ---- Build the app0 runtime layout + libs junction ----
    emit('Building runtime layout…', 88, 'building-layout')
    // Everything from the dump belongs under app0/ (the runtime maps /app0/ to
    // <cwd>/app0); only the relinked exe, libs, and intermediates stay at root.
    await buildLayout(installDir, [
      path.basename(exePath),
      'cover.png',
      // AnyPS5's startup dependency report — keep it next to the exe for
      // support instead of burying it under app0.
      'windows-diagnostics-imports.txt'
    ])
    if (!fs.existsSync(path.join(installDir, 'app0'))) {
      throw new Error(
        'The runtime app0/ folder was not created — the conversion was incomplete. Retry the installation.'
      )
    }
    // From here on the game is fully converted; a later failure (finalize or
    // swap) must not be downgraded to a Not-working entry.
    phase = 'converted'

    // ---- Cover art ----
    let cover: string | null = null
    for (const candidate of ['icon0.png', 'pic0.png', 'pic1.png']) {
      try {
        await fsp.copyFile(
          path.join(installDir, 'app0', 'sce_sys', candidate),
          path.join(installDir, 'cover.png')
        )
        cover = 'cover.png'
        break
      } catch {
        /* try the next artwork file */
      }
    }

    // ---- Finalize: drop large intermediates ----
    emit('Finalizing…', 95, 'finalizing')
    await fsp.rm(ebootDest, { force: true })
    await fsp.rm(inputElf, { force: true })
    await fsp.rm(modDir, { recursive: true, force: true })
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      tempDir = null
    }

    // ---- Swap the staged build into place ----
    // A stale `.old` folder from a crashed swap must never block a retry —
    // pick a unique name when it cannot be removed (e.g. a running game holds
    // a file open).
    let retire = `${finalDir}.old`
    await fsp.rm(retire, { recursive: true, force: true }).catch(() => {})
    if (fs.existsSync(retire)) retire = `${finalDir}.old-${Date.now()}`
    if (fs.existsSync(finalDir)) {
      // Park the previous install first: if the swap fails it is restored,
      // so a re-install is never left half-replaced.
      await fsp.rename(finalDir, retire)
    }
    try {
      await fsp.rename(installDir, finalDir)
    } catch (swapError) {
      if (fs.existsSync(retire)) await fsp.rename(retire, finalDir).catch(() => {})
      throw swapError
    }
    await fsp.rm(retire, { recursive: true, force: true }).catch(() => {})
    activeStages.delete(stageName)
    stageDir = null

    // ---- Post-install launch test: verify the game actually starts --------
    // The verdict goes into the library so the UI can show Works / Not
    // working. A failed launch never fails the installation itself.
    emit('Launch test — starting the game…', 97, 'launch-test')
    let probe: LaunchProbe = { state: 'failed', detail: 'the launch test could not start' }
    try {
      probe = await probeLaunch(path.join(finalDir, path.basename(exePath)), finalDir)
    } catch (error) {
      probe = { state: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
    // If the converter had to skip an encrypted SELF module or a module it
    // could not represent on Windows, a failed launch is usually that module
    // missing at runtime — say so instead of leaving a bare fault code.
    const skipped = [...new Set([...relinked.skippedSelf, ...skippedModules])]
    if (probe.state === 'failed' && skipped.length > 0) {
      const listed = skipped.slice(0, 3).join(', ')
      const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''
      const hint =
        relinked.skippedSelf.length > 0
          ? 'decrypt the dump and retry for the best chance'
          : 're-copy or re-extract the dump for the best chance'
      probe = {
        ...probe,
        detail: `${probe.detail} — the converter skipped ${skipped.length === 1 ? 'a module' : `${skipped.length} modules`} (${listed}${more}); ${hint}.`
      }
    }

    // AnyPS5 0.1.3 throws from sceNpTrophy2GetTrophyInfo when a title probes a
    // trophy id its own package does not define. The console answers that probe
    // with the invalid-id error and titles use it as a loop sentinel; the throw
    // aborts the guest instead. With no package loaded the same runtime answers
    // every id with placeholder data and returns success, so hide the package
    // and retry once. This is per game and reversible in the Compatibility
    // panel; it is far better than reporting a title that starts as unplayable.
    let compatibility: GameCompatibility | undefined
    if (probe.state === 'failed' && probe.trophyAbort) {
      const trophyId = probe.trophyAbort.trophyId
      emit('Launch test — retrying with placeholder trophy data…', 98, 'launch-test')
      const hidden = await setTrophyDataMode(finalDir, 'placeholders')
      if (hidden.changed.length > 0) {
        compatibility = { trophyData: 'placeholders' }
        try {
          probe = await probeLaunch(path.join(finalDir, path.basename(exePath)), finalDir)
        } catch (error) {
          probe = {
            state: 'failed',
            detail: error instanceof Error ? error.message : String(error)
          }
        }
        if (probe.state === 'works') {
          probe = {
            ...probe,
            detail: `${probe.detail} — trophy data hidden: the runtime aborts on trophy ${trophyId}, which the game's own trophy package does not define`
          }
        }
      } else if (hidden.error) {
        probe = {
          ...probe,
          detail: `${probe.detail}; could not hide the trophy package: ${hidden.error}`
        }
      }
    }

    const sizeBytes = await dirSize(finalDir)
    const game: Game = {
      id,
      name,
      titleId: meta.titleId,
      sourcePath: persistentSource,
      installPath: finalDir,
      exePath: path.join(finalDir, path.basename(exePath)),
      sizeBytes,
      cover,
      status: 'ready',
      installedAt: Date.now(),
      launchState: probe.state,
      launchDetail: probe.detail,
      ...(compatibility ? { compatibility } : {})
    }
    await addGame(game)

    report({
      jobId,
      step: 'done',
      message:
        probe.state === 'works'
          ? 'Installed — launch test passed, the game is running'
          : 'Installed — launch test failed',
      percent: 100,
      status: 'done',
      gameId: id,
      gameName: name,
      launchState: probe.state,
      launchDetail: probe.detail
    })
    return game
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The dump was fully copied and only conversion failed: never throw it
    // away. Register it as Not working and let the user retry later.
    if (phase === 'converting') {
      try {
        const game = await registerFailed(message)
        if (game) return game
      } catch (fallbackError) {
        console.warn(
          `[install] could not keep the failed conversion: ${
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }`
        )
      }
    }
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    // Drop only the staged partial build. A previously working install (and
    // its library entry) stays untouched, so a failed re-install is retryable
    // without losing the game that already worked.
    if (stageDir) {
      activeStages.delete(path.basename(stageDir))
      await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    }
    report({ jobId, step, message: 'Failed', percent, status: 'error', error: message })
    throw error
  }
}
