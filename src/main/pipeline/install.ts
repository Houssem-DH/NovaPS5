import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { gamesRoot, ensureDir } from '../paths'
import { detectContainer } from './elf'
import { unwrapSelf } from './unwrap'
import { relink } from './relink'
import { copyDir, dirSize } from './copy'
import { buildLayout } from './layout'
import { resolveSource, readMeta } from './dump'
import { checkCompatibility, formatBlockers, isBackupName } from './compat'
import { addGame, getGame, slugify } from '../library'
import type { Game, InstallProgress, InstallStep } from '@shared/types'

// Skip leftover unwrap backups — the original SELF is not needed at runtime
// and a duplicate ELF next to its real module would collide by SONAME.
function isBackup(name: string): boolean {
  return name.endsWith('.esbak')
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

  const emit = (message: string, pct: number, s: InstallStep): void => {
    step = s
    // Keep the reported value an integer — it renders directly in the UI.
    percent = Math.round(pct)
    report({ jobId, step, message, percent, status: 'running' })
  }

  try {
    emit('Validating source…', 2, 'validating')
    const resolved = await resolveSource(sourcePath)
    tempDir = resolved.tempDir
    const dumpRoot = resolved.root

    if (!fs.existsSync(path.join(dumpRoot, 'eboot.bin'))) {
      throw new Error('No eboot.bin found — this does not look like a PS5 game dump.')
    }

    // ---- Compatibility test: fail fast with a clear report, before any copy
    emit('Checking compatibility…', 4, 'validating')
    const compat = await checkCompatibility(dumpRoot)
    const blockers = formatBlockers(compat)
    if (blockers) throw new Error(`Not compatible — ${blockers}`)

    const meta = await readMeta(dumpRoot)
    const name = (nameOverride?.trim() || meta.name).slice(0, 90)
    const baseId = slugify(name)

    // Pick an install dir:
    //  - re-installing the SAME title (matching titleId) replaces its folder;
    //  - a different title with the same display name, or an existing folder
    //    not owned by this title, gets a unique suffixed id so nothing else
    //    is ever overwritten.
    const owned = await getGame(baseId)
    const sameTitle = !!owned && !!meta.titleId && owned.titleId === meta.titleId
    let id = baseId
    if (!sameTitle) {
      let n = 2
      const taken = async (candidate: string): Promise<boolean> =>
        !!(await getGame(candidate)) || fs.existsSync(path.join(gamesRoot(), candidate))
      while (await taken(id)) id = `${baseId}-${n++}`
    }
    const finalDir = path.join(gamesRoot(), id)
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
      (entry) => !isBackup(entry.name)
    )
    let total = 0
    for (const entry of entries) total += await dirSize(path.join(dumpRoot, entry.name))
    let copied = 0
    let lastCopyEmit = 0
    emit('Copying game data…', 8, 'copying')
    for (const entry of entries) {
      const src = path.join(dumpRoot, entry.name)
      const dest = path.join(installDir, entry.name)
      const stat = await fsp.stat(src)
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
      if (entry.isDirectory()) await copyDir(src, dest, tick)
      else if (entry.isFile()) {
        await fsp.copyFile(src, dest)
        tick(stat.size)
      }
    }

    // ---- Unwrap the eboot (SELF -> ELF) ----
    const ebootDest = path.join(installDir, 'eboot.bin')
    const inputElf = path.join(installDir, 'input.elf')
    const ebootKind = detectContainer(ebootDest)
    if (ebootKind === 'self') {
      emit('Unwrapping eboot (SELF → ELF)…', 55, 'unwrapping-eboot')
      await unwrapSelf(ebootDest, inputElf)
    } else if (ebootKind === 'elf') {
      // already a plain ELF — the relinker can read it directly
      await fsp.copyFile(ebootDest, inputElf)
    } else {
      // Never hand an unrecognized file to the relinker — it fails with a
      // cryptic conversion error instead of naming the real problem.
      throw new Error(
        'eboot.bin is neither a plain ELF nor a SELF container — the dump file is corrupted or incomplete.'
      )
    }

    // ---- Prepare bundled modules (unwrap SELF, drop .esbak backups) ----
    // PS4/PS5 titles keep loadable modules in sce_module/, but PS4 titles
    // also ship modules beside it (Media/Modules for Il2Cpp/PS4Util,
    // Media/Plugins for runtime-loaded plugins). Discover every *.prx
    // outside sce_sys, unwrap each SELF in place, and remember its
    // directory so the relinker converts it too (sce_module/ is built in).
    emit('Preparing modules…', 60, 'preparing-modules')
    const prxDirs: string[] = [] // every directory (relative) holding modules
    const moduleDirs: string[] = [] // …that need an explicit --module-dir
    const scanForModules = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > 4) return
      let entries: import('fs').Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      let hasPrx = false
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'sce_sys') continue // metadata only, no modules
          await scanForModules(full, rel ? path.join(rel, entry.name) : entry.name, depth + 1)
        } else if (entry.name.endsWith('.esbak')) {
          // leftover backup; its internal SONAME collides with the real module
          await fsp.rm(full, { force: true })
        } else if (entry.name.endsWith('.prx')) {
          hasPrx = true
        }
      }
      if (hasPrx && rel) {
        prxDirs.push(rel)
        // The relinker auto-scans sce_module/sce_modules/prx itself — passing
        // those again as --module-dir is a duplicate-directory error.
        if (rel !== 'sce_module' && rel !== 'sce_modules' && rel !== 'prx') moduleDirs.push(rel)
      }
    }
    await scanForModules(installDir, '', 0)

    // Backup leftovers sit inside module folders — exactly where the relinker
    // scans content-first (any ELF magic counts, extension ignored). A backup
    // copy of a module re-registers the same SONAME and aborts the conversion
    // with "Ambiguous guest dependency name". Pruned from the staging copy
    // only; the source dump is never modified.
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel)
      for (const file of await fsp.readdir(dir)) {
        if (isBackupName(file)) {
          await fsp.rm(path.join(dir, file), { force: true })
        }
      }
    }
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel)
      for (const file of await fsp.readdir(dir)) {
        if (!file.endsWith('.prx')) continue
        const filePath = path.join(dir, file)
        const kind = detectContainer(filePath)
        if (kind === 'self') {
          emit(`Unwrapping ${file}…`, 60, 'preparing-modules')
          await unwrapSelf(filePath, filePath)
        } else if (kind !== 'elf') {
          // Same rule as the eboot: a module the relinker can't read must
          // fail here with a clear message, not as a cryptic conversion error.
          throw new Error(
            `${path.join(rel, file)} is neither a plain ELF nor a SELF container — the dump's module is corrupted or incomplete.`
          )
        }
      }
    }
    const modDir = path.join(installDir, 'sce_module')

    // ---- Relink into a Windows executable ----
    emit('Converting to a Windows executable…', 68, 'relinking')
    const safeName = name.replace(/[\\/:*?"<>|]/g, '').trim() || 'game'
    const exePath = path.join(installDir, `${safeName}.exe`)
    // cwd = installDir so the relinker writes app0/ next to the exe
    await relink(inputElf, exePath, undefined, installDir, moduleDirs)

    // The raw module sources were consumed by the relinker — only the
    // converted *.guest.prx files belong in the final arrangement.
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel)
      for (const file of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (file.endsWith('.prx') && !file.endsWith('.guest.prx')) {
          await fsp.rm(path.join(dir, file), { force: true })
        }
      }
    }

    // ---- Build the app0 runtime layout + libs junction ----
    emit('Building runtime layout…', 88, 'building-layout')
    // Everything from the dump belongs under app0/ (the runtime maps /app0/ to
    // <cwd>/app0); only the relinked exe, libs, and intermediates stay at root.
    await buildLayout(installDir, [path.basename(exePath), 'cover.png'])

    // ---- Cover art ----
    let cover: string | null = null
    try {
      await fsp.copyFile(
        path.join(installDir, 'app0', 'sce_sys', 'icon0.png'),
        path.join(installDir, 'cover.png')
      )
      cover = 'cover.png'
    } catch {
      /* no cover art in this dump */
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
    const retire = `${finalDir}.old`
    await fsp.rm(retire, { recursive: true, force: true }).catch(() => {})
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

    const sizeBytes = await dirSize(finalDir)
    const game: Game = {
      id,
      name,
      titleId: meta.titleId,
      sourcePath: dumpRoot,
      installPath: finalDir,
      exePath: path.join(finalDir, path.basename(exePath)),
      sizeBytes,
      cover,
      status: 'ready',
      installedAt: Date.now()
    }
    await addGame(game)

    report({ jobId, step: 'done', message: 'Ready to play', percent: 100, status: 'done', gameId: id, gameName: name })
    return game
  } catch (error) {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    // Drop only the staged partial build. A previously working install (and
    // its library entry) stays untouched, so a failed re-install is retryable
    // without losing the game that already worked.
    if (stageDir) {
      activeStages.delete(path.basename(stageDir))
      await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    }
    const message = error instanceof Error ? error.message : String(error)
    report({ jobId, step, message: 'Failed', percent, status: 'error', error: message })
    throw error
  }
}
