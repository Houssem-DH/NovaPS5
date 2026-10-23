import fs from 'fs'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { detectContainer, readElfDynamicInfo, readMagicHex } from './elf'
import { readMeta } from './dump'
import { unwrapSelf } from './unwrap'
import { pythonInvocation } from '../python'
import { toolingPresent, runtimeLibsDir } from '../paths'
import type { CompatCheck } from '@shared/types'

/**
 * Leftover backup files (libc.prx.bak_20260710_185300, x.orig, foo~ …).
 * Inside a module folder these are dangerous: the relinker imports any file
 * whose content starts with ELF magic regardless of extension, and a backup
 * copy of a module re-registers the same SONAME → "Ambiguous guest
 * dependency name". Installs prune them from the staging copy.
 */
export function isBackupName(name: string): boolean {
  return /\.(bak|backup|old|orig)([._-].*)?$/i.test(name) || name.endsWith('~')
}

/**
 * Where the installer prefers to keep a module when duplicate copies collide
 * (install.ts prunes losers with the same ranking so the report matches what
 * actually happens).
 */
export function moduleDirRank(rel: string): number {
  // Windows treats folder names case-insensitively; a dump with Sce_Module/
  // must rank the same as sce_module/ so the duplicate scan does not pass it
  // to the relinker as an extra --module-dir.
  const key = rel.replace(/\\/g, '/').toLowerCase()
  if (key === 'sce_module') return 0
  if (key === 'sce_modules') return 1
  if (key === 'prx') return 2
  return 3
}

/** "libScePad.prx" / "/some/dir/libScePad.so" -> "libscepad" */
function normalizeLibName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.toLowerCase().replace(/\.(prx|sprx|so|elf)$/, '')
}

/** Extensions that usually denote a loadable guest module. */
const MODULE_EXTENSIONS = /\.(prx|sprx|so|elf)$/i
/** Folder names the relinker (or PS4 games) conventionally keep modules in. */
const MODULE_DIR_NAMES = /^(sce_modules?|prx|modules?|plugins?)$/i
const MAX_SCAN_DEPTH = 6

/**
 * "fakelib" folders ship stand-in copies of the console's system libraries.
 * They exist for loaders that have no implementations of their own, so their
 * imports point at kernel/graphics NIDs a normal runtime may not have.
 *
 * AnyPS5 provides its own system libraries. Converting these stubs makes the
 * generated Windows entry point resolve their imports eagerly: every missing
 * NID turns into `FAIL: unresolved ELF import …` and the process aborts with
 * `GetLastError: 127` before the title's own code runs. They must stay
 * unconverted — the runtime's libraries take their place.
 */
export function isShimModuleDir(rel: string): boolean {
  return rel
    .split(/[\\/]+/)
    .some((part) => /^fake[-_ ]?libs?$/i.test(part))
}

export interface ShimModule {
  /** Directory relative to the dump root, forward slashes. */
  rel: string
  name: string
}

export interface ModuleCandidate {
  /** Directory relative to the dump root, forward slashes. */
  rel: string
  name: string
  /** Absolute path in the dump (or staging folder) being inspected. */
  path: string
  magic: 'elf' | 'self'
}

export interface ModuleDiscovery {
  /** Directories that contain at least one loadable module, best first. */
  dirs: string[]
  files: ModuleCandidate[]
  /**
   * Fake system libraries from a `fakelib` shim folder. They are deliberately
   * not converted (see `isShimModuleDir`); the runtime provides the real
   * implementations.
   */
  shims: ShimModule[]
  /** Backup leftovers inside module folders (relative, forward slashes). */
  backups: string[]
  /**
   * Previous conversion outputs / crashed-unwrap temp files. They are never
   * source modules; the installer removes them from the staging copy so a
   * re-imported or re-converted dump cannot feed a PE `.guest.prx` back into
   * the converter.
   */
  leftovers: string[]
}

function sortCandidates<T extends { rel: string; name: string }>(items: T[]): T[] {
  return items.sort(
    (a, b) =>
      moduleDirRank(a.rel) - moduleDirRank(b.rel) ||
      a.rel.localeCompare(b.rel) ||
      a.name.localeCompare(b.name)
  )
}

/**
 * Find every file the relinker will treat as a guest module.
 *
 * The relinker picks files up by *content*, not extension, but only inside the
 * folders it scans (sce_module/, sce_modules/, prx/ and every --module-dir).
 * Scanning the whole dump's content would be prohibitively slow, so:
 *
 *  - files with a module-ish extension are always inspected;
 *  - folders with a module-ish name (Media/Modules, Media/Plugins, …) have
 *    every file inspected, which catches extensionless SELF modules;
 *  - backups are collected inside those folders so the installer can prune
 *    them before the relinker sees a duplicate SONAME.
 */
export async function discoverModuleFiles(root: string): Promise<ModuleDiscovery> {
  const dirs = new Set<string>()
  const files: ModuleCandidate[] = []
  const shims: ShimModule[] = []
  const backups: string[] = []
  const leftovers: string[] = []

  const visit = async (full: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return
    // Every file in a fake-library folder is a stand-in for a system library,
    // never a title module. Record it for the report and keep it out of the
    // conversion (see isShimModuleDir).
    const shimDir = rel !== '' && isShimModuleDir(rel)
    let entries: import('fs').Dirent[]
    try {
      entries = await fsp.readdir(full, { withFileTypes: true })
    } catch {
      return
    }

    const suspiciousDir = rel !== '' && MODULE_DIR_NAMES.test(path.basename(full))
    const dirFiles: ModuleCandidate[] = []
    const dirBackups: string[] = []
    const possibleBackups: Array<{ name: string; path: string }> = []
    const otherFiles: Array<{ name: string; path: string }> = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'sce_sys' || entry.name === '__MACOSX' || entry.name === 'app0') continue
        await visit(path.join(full, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const name = entry.name
      const filePath = path.join(full, name)
      const lowerName = name.toLowerCase()
      // Previous conversion outputs and crashed-unwrap temp files are never
      // source modules. Older builds validated every *.prx, so a re-imported
      // or pre-converted dump could fail on its own PE `*.guest.prx` output.
      // Record them for deletion instead of feeding them back to the converter.
      if (
        lowerName.endsWith('.guest.prx') ||
        /\.novaps5-unwrap-.*\.tmp$/i.test(name)
      ) {
        leftovers.push(rel ? `${rel}/${name}` : name)
        continue
      }
      // Backups are leftovers in a module folder (see below); `.esbak` is a
      // NovaPS5-specific backup name, so it is safe to remove anywhere.
      if (lowerName.endsWith('.esbak')) {
        leftovers.push(rel ? `${rel}/${name}` : name)
        possibleBackups.push({ name, path: filePath })
        continue
      }
      if (shimDir) {
        // Report the stand-in libraries without feeding them to the converter.
        // Their `.guest.prx` outputs were already collected as leftovers above.
        if (!isBackupName(name)) shims.push({ rel, name })
        continue
      }
      if (isBackupName(name)) {
        possibleBackups.push({ name, path: filePath })
        continue
      }
      // The relinker only scans module folders, never the dump root itself —
      // and the root holds eboot.bin/input.elf, which must never be treated
      // as guest modules.
      if (!rel) continue
      // Only inspect content when the name or folder says "module" — opening
      // every asset in a 100 GB dump just to read four bytes would make the
      // scan unusable.
      if (!suspiciousDir && !MODULE_EXTENSIONS.test(name)) {
        otherFiles.push({ name, path: filePath })
        continue
      }
      const kind = detectContainer(filePath)
      if (kind === 'elf' || kind === 'self') {
        dirFiles.push({ rel, name, path: filePath, magic: kind })
      }
    }

    // A folder that already contains a .prx/.sprx is a module folder; the
    // relinker scans every file in it by content. Catch extensionless modules
    // beside the named ones instead of letting the relinker skip them.
    if (dirFiles.length > 0 && !suspiciousDir) {
      for (const file of otherFiles) {
        const kind = detectContainer(file.path)
        if (kind === 'elf' || kind === 'self') {
          dirFiles.push({ rel, name: file.name, path: file.path, magic: kind })
        }
      }
    }

    if (dirFiles.length > 0 || suspiciousDir) {
      // Backup leftovers sit exactly where the relinker scans content-first. A
      // copy whose content is ELF/SELF re-registers the same SONAME, so it is
      // pruned. A text `save.bak` in a module folder is not a module and is
      // left alone (`.esbak` is NovaPS5's own backup and is always removed).
      for (const backup of possibleBackups) {
        const kind = detectContainer(backup.path)
        if (kind === 'elf' || kind === 'self') {
          dirBackups.push(rel ? `${rel}/${backup.name}` : backup.name)
          leftovers.push(rel ? `${rel}/${backup.name}` : backup.name)
        }
      }
    }

    if (dirFiles.length > 0) {
      if (rel) dirs.add(rel)
      files.push(...dirFiles)
      // Backups only matter where the relinker scans (a data folder's .bak is
      // harmless), so they are reported/pruned only from module-like folders.
      backups.push(...dirBackups)
    } else if (suspiciousDir && dirBackups.length > 0) {
      // Backup-only module folder: no candidates, but the relinker still
      // scans the folder by name, so its leftovers must be pruned.
      backups.push(...dirBackups)
    }
  }

  await visit(root, '', 0)

  return {
    dirs: [...dirs].sort((a, b) => moduleDirRank(a) - moduleDirRank(b) || a.localeCompare(b)),
    files: sortCandidates(files),
    shims: shims.sort((a, b) => a.rel.localeCompare(b.rel) || a.name.localeCompare(b.name)),
    backups,
    leftovers: [...new Set(leftovers)]
  }
}

export interface CompatReport {
  checks: CompatCheck[]
  /** False when any check has status 'fail' — installation must not start. */
  compatible: boolean
}

/** Strip the common error prefix so compatibility text reads naturally. */
function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Unwrap failed — /, '')
}

/**
 * Pre-install compatibility test: answers "will this dump convert?" before a
 * single game file is copied. Mirrors what the pipeline + relinker will do:
 * container detection, trial SELF unwraps (catches encrypted/truncated
 * eboots *and modules* immediately instead of at 55% of a real install), the
 * libraries the game depends on vs what the runtime provides (predicts launch
 * problems), tooling availability, and module-folder consistency (duplicate
 * names, duplicate SONAMEs, backup leftovers — all reconciled by the
 * installer, reported so nothing happens silently).
 */
export async function checkCompatibility(root: string): Promise<CompatReport> {
  const checks: CompatCheck[] = []

  // ---- Executable --------------------------------------------------------
  const eboot = path.join(root, 'eboot.bin')
  const kind = fs.existsSync(eboot) ? detectContainer(eboot) : 'missing'
  if (kind === 'elf') {
    checks.push({
      id: 'eboot',
      label: 'Executable',
      status: 'pass',
      detail: 'eboot.bin is a plain ELF — no unwrap needed.'
    })
  } else if (kind === 'self') {
    checks.push({
      id: 'eboot',
      label: 'Executable',
      status: 'pass',
      detail: 'eboot.bin is a PS5 SELF container — unwraps automatically.'
    })
  } else if (kind === 'missing') {
    checks.push({
      id: 'eboot',
      label: 'Executable',
      status: 'fail',
      detail: 'eboot.bin not found — this folder is not a complete dump.'
    })
  } else if (kind === 'pe') {
    // A Windows PE at eboot.bin means the selected folder is an installed or
    // already-converted build, not a dump. Re-importing it used to surface a
    // confusing module/executable corruption error.
    checks.push({
      id: 'eboot',
      label: 'Executable',
      status: 'fail',
      detail:
        'eboot.bin is a Windows executable, not a PS5 dump — this folder looks already converted. Import the original dump folder instead.'
    })
  } else {
    const bytes = readMagicHex(eboot)
    if (bytes === 'empty' || bytes === 'unreadable') {
      checks.push({
        id: 'eboot',
        label: 'Executable',
        status: 'fail',
        detail: `eboot.bin is ${bytes} — the dump is incomplete; re-copy or re-extract it.`
      })
    } else {
      // Not an ELF/SELF the relinker can read, but the user asked for
      // best-effort installs: keep going and register the game as Not working.
      checks.push({
        id: 'eboot',
        label: 'Executable',
        status: 'warn',
        detail: `eboot.bin is not a recognized ELF or SELF file (first bytes: ${bytes}) — it cannot be converted. Installation will complete with the game marked Not working.`
      })
    }
  }

  // ---- Module discovery --------------------------------------------------
  const discovery =
    kind === 'missing'
      ? { dirs: [], files: [], shims: [], backups: [], leftovers: [] }
      : await discoverModuleFiles(root)
  const moduleNotes: CompatCheck[] = []
  const moduleFileNames = new Set<string>()
  for (const file of discovery.files) moduleFileNames.add(file.name.toLowerCase())

  const hasSingular = fs.existsSync(path.join(root, 'sce_module'))
  const hasPlural = fs.existsSync(path.join(root, 'sce_modules'))
  const hasPrxDir = fs.existsSync(path.join(root, 'prx'))
  const hasRootModuleDir = hasSingular || hasPlural || hasPrxDir

  if (hasSingular && hasPlural) {
    // The relinker rejects both existing at once — the installer merges
    // sce_modules/ into sce_module/ on the staging copy instead of failing.
    moduleNotes.push({
      id: 'modules-both',
      label: 'Modules',
      status: 'warn',
      detail:
        'Both sce_module/ and sce_modules/ exist — sce_modules/ will be merged into sce_module/ automatically.'
    })
  }

  // A dump with no modules at all is still convertible: the installer creates
  // an empty sce_module/ so the converter has a module root, and the runtime
  // may provide every system library the game asks for. Treat it as a warning
  // so those games are not blocked.
  if (!hasRootModuleDir && discovery.dirs.length === 0 && discovery.backups.length === 0) {
    moduleNotes.push({
      id: 'modules-none',
      label: 'Modules',
      status: 'warn',
      detail:
        'No module folder found — conversion will continue without bundled modules. Games that need their own libraries may fail to launch.'
    })
  } else if (discovery.files.length === 0) {
    moduleNotes.push({
      id: 'modules-empty',
      label: 'Modules',
      status: 'warn',
      detail:
        'Module folders contain no loadable modules — conversion will continue without them. Some games may fail to launch.'
    })
  }

  // Fake system libraries from a loader shim folder are reported as a good
  // thing, not a warning: converting them is what breaks the entry point.
  if (discovery.shims.length > 0) {
    const folders = [...new Set(discovery.shims.map((file) => file.rel))].join(', ')
    moduleNotes.push({
      id: 'modules-shims',
      label: 'Modules',
      status: 'pass',
      detail: `${discovery.shims.length} stand-in system librar${
        discovery.shims.length === 1 ? 'y' : 'ies'
      } in ${folders} will be left alone — the runtime provides its own implementations, and converting these stubs stops the game from starting.`
    })
  }

  // A dump that was already converted in place (or copied back from an install)
  // can contain the relinker's own Windows PE outputs. They are never source
  // modules; the installer removes them from the staging copy before scanning.
  const previousOutputs = discovery.leftovers.filter((rel) => /\.guest\.prx$/i.test(rel))
  if (previousOutputs.length > 0) {
    const shown = previousOutputs.slice(0, 3).join(', ')
    const more = previousOutputs.length > 3 ? ` (+${previousOutputs.length - 3} more)` : ''
    moduleNotes.push({
      id: 'modules-outputs',
      label: 'Modules',
      status: 'warn',
      detail: `Previous conversion output${previousOutputs.length === 1 ? '' : 's'} will be removed before converting: ${shown}${more}.`
    })
  }

  // Duplicate filenames (case-folded, as the converter folds names on
  // Windows). The installer resolves them automatically: keep the copy in the
  // primary folder (sce_module > sce_modules > prx > elsewhere) and drop the
  // rest from the staging copy.
  const byName = new Map<string, ModuleCandidate[]>()
  for (const file of discovery.files) {
    const folded = file.name.toLowerCase()
    const bucket = byName.get(folded)
    if (bucket) bucket.push(file)
    else byName.set(folded, [file])
  }
  for (const [, bucket] of byName) {
    if (bucket.length < 2) continue
    bucket.sort(
      (a, b) =>
        moduleDirRank(a.rel) - moduleDirRank(b.rel) ||
        a.rel.localeCompare(b.rel) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name)
    )
    const locations = [...new Set(bucket.map((f) => `${f.rel}/${f.name}`))].join(' and ')
    moduleNotes.push({
      id: `modules-dup-${bucket[0].name.toLowerCase()}`,
      label: 'Modules',
      status: 'warn',
      detail: `Duplicate module "${bucket[0].name}" at ${locations} — the converter keeps the copy in ${bucket[0].rel}/ and skips the others.`
    })
  }

  if (discovery.backups.length > 0) {
    const shown = discovery.backups.slice(0, 3).join(', ')
    const more =
      discovery.backups.length > 3 ? ` (+${discovery.backups.length - 3} more)` : ''
    moduleNotes.push({
      id: 'modules-backups',
      label: 'Modules',
      status: 'warn',
      detail: `Backup leftovers will be skipped during conversion: ${shown}${more}.`
    })
  }

  // Content-ELF files without a .prx name (not backups) — the relinker
  // includes them by content, so the installer unwraps and converts them too.
  const strays = discovery.files.filter((file) => !/\.prx$/i.test(file.name))
  if (strays.length > 0) {
    const shown = strays.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(', ')
    const more = strays.length > 3 ? ` (+${strays.length - 3} more)` : ''
    moduleNotes.push({
      id: 'modules-strays',
      label: 'Modules',
      status: 'warn',
      detail: `Module-like files without a .prx name will still be converted: ${shown}${more}.`
    })
  }

  // The relinker rejects guest filenames with non-ASCII characters, ':' or
  // '$' because they cannot become Windows file names. Catch it here instead
  // of failing mid-conversion.
  const badModuleNames = discovery.files.filter((file) => /[^\x20-\x7e]|[:$]/.test(file.name))
  if (badModuleNames.length > 0) {
    const shown = badModuleNames
      .slice(0, 3)
      .map((f) => `${f.rel}/${f.name}`)
      .join(', ')
    const more = badModuleNames.length > 3 ? ` (+${badModuleNames.length - 3} more)` : ''
    moduleNotes.push({
      id: 'modules-filename',
      label: 'Modules',
      status: 'warn',
      detail: `The converter cannot use these module filenames on Windows: ${shown}${more}. They will be skipped so the rest of the game can still install; the game may fail to launch. Rename them inside the dump for the best result.`
    })
  }

  // ---- Python + trial unwraps -------------------------------------------
  const selfModules = discovery.files.filter((file) => file.magic === 'self')
  const needsPython = kind === 'self' || selfModules.length > 0
  let pythonReady = false

  if (needsPython) {
    const python = await pythonInvocation()
    pythonReady = !!python
    checks.push(
      python
        ? {
            id: 'python',
            label: 'Python',
            status: 'pass',
            detail: python.bundled
              ? 'Bundled Python is available for the SELF unwrap step.'
              : 'Python 3 available for the SELF unwrap step.'
          }
        : {
            id: 'python',
            label: 'Python',
            status: 'fail',
            detail: 'The bundled Python is missing — repair or reinstall NovaPS5.'
          }
    )
  }

  const needed = new Set<string>()
  const moduleSonames: Array<{ soname: string; file: ModuleCandidate }> = []
  const moduleUnwrapFailures: string[] = []

  const collectElf = (elfPath: string): void => {
    const info = readElfDynamicInfo(elfPath)
    if (!info) return
    for (const name of info.needed) needed.add(name)
  }

  if ((!needsPython || pythonReady) && (kind === 'self' || kind === 'elf' || discovery.files.length > 0)) {
    const trialDir = await fsp.mkdtemp(path.join(os.tmpdir(), `novaps5-compat-${process.pid}-`))
    try {
      // The eboot's trial unwrap answers two questions that otherwise surface
      // only at 55% of a real install: does it unwrap (encrypted/truncated
      // containers), and which libraries does the game ask for?
      if (kind === 'self') {
        try {
          const outElf = path.join(trialDir, 'eboot.elf')
          await unwrapSelf(eboot, outElf)
          collectElf(outElf)
          checks.push({
            id: 'unwrap',
            label: 'Eboot unwrap',
            status: 'pass',
            detail: 'Trial unwrap succeeded — the executable converts cleanly.'
          })
        } catch (error) {
          checks.push({
            id: 'unwrap',
            label: 'Eboot unwrap',
            status: 'warn',
            detail: `The eboot cannot be converted: ${errorDetail(error)}. Installation will complete with the game marked Not working.`
          })
        }
      } else if (kind === 'elf') {
        collectElf(eboot)
      }

      // Trial-unwrap every SELF module too. This catches an encrypted module
      // before the copy, and gives the installer the SONAME/import data it
      // needs to reconcile duplicates and predict launch failures.
      for (let i = 0; i < discovery.files.length; i++) {
        const file = discovery.files[i]
        try {
          const elfPath =
            file.magic === 'self'
              ? path.join(trialDir, `module-${i}.elf`)
              : file.path
          if (file.magic === 'self') await unwrapSelf(file.path, elfPath)
          const info = readElfDynamicInfo(elfPath)
          if (!info) {
            if (file.magic === 'self') {
              moduleUnwrapFailures.push(`${file.rel}/${file.name}: unreadable ELF`)
            }
            continue
          }
          for (const name of info.needed) needed.add(name)
          if (info.soname) {
            moduleSonames.push({ soname: info.soname, file })
          }
        } catch (error) {
          moduleUnwrapFailures.push(`${file.rel}/${file.name}: ${errorDetail(error)}`)
        }
      }
    } finally {
      await fsp.rm(trialDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (moduleUnwrapFailures.length > 0) {
    const shown = moduleUnwrapFailures.slice(0, 3).join('; ')
    const more =
      moduleUnwrapFailures.length > 3 ? ` (+${moduleUnwrapFailures.length - 3} more)` : ''
    moduleNotes.push({
      id: 'modules-unwrap',
      label: 'Modules',
      status: 'warn',
      detail: `Some modules cannot be converted and will be skipped: ${shown}${more}. Installation will continue so the rest of the game can install, but the game may fail to launch. Re-copy or re-extract the dump for the best chance.`
    })
  }

  // Duplicate SONAME across folders — the relinker aborts with "Ambiguous
  // guest module identity"; the installer keeps the highest-ranked copy.
  const bySoname = new Map<string, Array<{ soname: string; file: ModuleCandidate }>>()
  for (const entry of moduleSonames) {
    const key = entry.soname.toLowerCase()
    const bucket = bySoname.get(key)
    if (bucket) bucket.push(entry)
    else bySoname.set(key, [entry])
  }
  for (const [, bucket] of bySoname) {
    if (bucket.length < 2) continue
    bucket.sort(
      (a, b) =>
        moduleDirRank(a.file.rel) - moduleDirRank(b.file.rel) ||
        a.file.rel.localeCompare(b.file.rel) ||
        a.file.name.length - b.file.name.length ||
        a.file.name.localeCompare(b.file.name)
    )
    const locations = bucket.map((e) => `${e.file.rel}/${e.file.name}`).join(' and ')
    moduleNotes.push({
      id: `modules-soname-${bucket[0].soname.toLowerCase()}`,
      label: 'Modules',
      status: 'warn',
      detail: `Modules ${locations} share the identity "${bucket[0].soname}" — the converter keeps the copy in ${bucket[0].file.rel}/ and skips the others.`
    })
  }

  if (discovery.files.length > 0 && !moduleNotes.some((check) => check.status === 'fail')) {
    // Informational notes (like skipped fake libraries) must not turn the
    // summary into a warning; only real caveats do.
    const noteCount = moduleNotes.filter((check) => check.status !== 'pass').length
    const count = discovery.files.length
    moduleNotes.push({
      id: 'modules',
      label: 'Modules',
      status: noteCount > 0 ? 'warn' : 'pass',
      detail: `${count} loadable module${count === 1 ? '' : 's'} found${noteCount > 0 ? ' — the notes above are reconciled during conversion' : ' — folders are consistent'}.`
    })
  }
  checks.push(...moduleNotes)

  // ---- Libraries the game depends on -------------------------------------
  const tools = toolingPresent()
  if (needed.size > 0 && tools.libs) {
    const provided = new Set<string>()
    try {
      for (const entry of fs.readdirSync(runtimeLibsDir(), { withFileTypes: true })) {
        if (entry.isFile()) provided.add(normalizeLibName(entry.name))
      }
    } catch {
      // A missing runtime is already reported by the runtime check below.
    }
    for (const name of moduleFileNames) provided.add(normalizeLibName(name))
    for (const entry of moduleSonames) provided.add(normalizeLibName(entry.soname))
    const required = [...needed]
    const missing = required.filter((name) => !provided.has(normalizeLibName(name)))
    checks.push(
      missing.length > 0
        ? {
            id: 'deps',
            label: 'Libraries',
            status: 'warn',
            detail: `Requires libraries the conversion runtime does not provide: ${missing
              .slice(0, 4)
              .join(', ')}${missing.length > 4 ? ` (+${missing.length - 4} more)` : ''} — the game may fail to launch.`
          }
        : {
            id: 'deps',
            label: 'Libraries',
            status: 'pass',
            detail: `All ${required.length} required librar${required.length === 1 ? 'y is' : 'ies are'} provided by the runtime or the dump.`
          }
    )
  }

  // ---- Conversion runtime ------------------------------------------------
  checks.push(
    tools.relinker && tools.libs && tools.unwrap
      ? {
          id: 'runtime',
          label: 'Runtime',
          status: 'pass',
          detail: 'Conversion runtime is installed and ready.'
        }
      : {
          id: 'runtime',
          label: 'Runtime',
          status: 'fail',
          detail: 'Conversion runtime is incomplete — restart NovaPS5 to download it.'
        }
  )

  // ---- Title metadata ----------------------------------------------------
  const meta = await readMeta(root)
  checks.push(
    meta.titleId
      ? {
          id: 'meta',
          label: 'Metadata',
          status: 'pass',
          detail: `Title detected: ${meta.name} (${meta.titleId}).`
        }
      : {
          id: 'meta',
          label: 'Metadata',
          status: 'warn',
          detail: 'Title metadata unreadable — the folder name will be used.'
        }
  )

  return { checks, compatible: checks.every((check) => check.status !== 'fail') }
}

/** One-line summary of every blocking issue, for install-time errors. */
export function formatBlockers(report: CompatReport): string | null {
  const blockers = report.checks.filter((check) => check.status === 'fail')
  if (blockers.length === 0) return null
  return blockers.map((check) => `${check.label}: ${check.detail}`).join(' ')
}
