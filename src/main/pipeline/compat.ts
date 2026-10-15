import fs from 'fs'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { detectContainer, readMagicHex } from './elf'
import { readMeta } from './dump'
import { unwrapSelf } from './unwrap'
import { pythonInvocation } from '../python'
import { toolingPresent, runtimeLibsDir } from '../paths'
import type { CompatCheck } from '@shared/types'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
// Standard decrypted SELF plus the alternate container form the relinker
// recognizes (NativeModules.cpp treats both as SELF).
const SELF_MAGICS = [
  Buffer.from([0x4f, 0x15, 0x3d, 0x1d]),
  Buffer.from([0x54, 0x14, 0xf5, 0xee])
]

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

/** First-bytes classification mirroring the relinker's content-based pickup. */
async function fileMagic(file: string): Promise<'elf' | 'self' | 'other'> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
  try {
    handle = await fsp.open(file, 'r')
    const buf = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buf, 0, 4, 0)
    if (bytesRead < 4) return 'other'
    if (buf.equals(ELF_MAGIC)) return 'elf'
    if (SELF_MAGICS.some((magic) => buf.equals(magic))) return 'self'
    return 'other'
  } catch {
    return 'other'
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * Where the installer prefers to keep a module when duplicate copies collide
 * (install.ts prunes losers with the same ranking so the report matches what
 * actually happens).
 */
export function moduleDirRank(rel: string): number {
  if (rel === 'sce_module') return 0
  if (rel === 'sce_modules') return 1
  if (rel === 'prx') return 2
  return 3
}

/** "libScePad.prx" / "/some/dir/libScePad.so" -> "libscepad" */
function normalizeLibName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.toLowerCase().replace(/\.(prx|sprx|so|elf)$/, '')
}

/**
 * DT_NEEDED entries of an ELF file (plain file offsets — pass a *unwrapped*
 * eboot, not a SELF container). Returns null when parsing isn't possible,
 * which is never fatal for the report itself.
 */
function readNeeded(elfPath: string): string[] | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(elfPath, 'r')
    const head = Buffer.alloc(64)
    if (fs.readSync(fd, head, 0, 64, 0) < 52) return null
    if (!head.subarray(0, 4).equals(ELF_MAGIC)) return null
    const is64 = head[4] === 2
    const phoff = Number(is64 ? head.readBigUInt64LE(32) : head.readUInt32LE(28))
    const phentsize = head.readUInt16LE(is64 ? 54 : 42)
    const phnum = head.readUInt16LE(is64 ? 56 : 44)
    if (phnum === 0 || phnum > 256) return null

    const loads: Array<{ vaddr: number; off: number; filesz: number }> = []
    let dynOff = -1
    let dynSize = 0

    const phdr = Buffer.alloc(phentsize)
    for (let i = 0; i < phnum; i++) {
      fs.readSync(fd, phdr, 0, phentsize, phoff + i * phentsize)
      const type = phdr.readUInt32LE(0)
      if (is64) {
        const off = Number(phdr.readBigUInt64LE(8))
        const vaddr = Number(phdr.readBigUInt64LE(16))
        const filesz = Number(phdr.readBigUInt64LE(32))
        if (type === 1) loads.push({ vaddr, off, filesz })
        else if (type === 2) {
          dynOff = off
          dynSize = filesz
        }
      } else {
        const off = phdr.readUInt32LE(4)
        const vaddr = phdr.readUInt32LE(8)
        const filesz = phdr.readUInt32LE(16)
        if (type === 1) loads.push({ vaddr, off, filesz })
        else if (type === 2) {
          dynOff = off
          dynSize = filesz
        }
      }
    }
    if (dynOff < 0 || dynSize <= 0) return null

    const vaddrToOff = (vaddr: number): number => {
      for (const load of loads) {
        if (vaddr >= load.vaddr && vaddr < load.vaddr + load.filesz) {
          return load.off + (vaddr - load.vaddr)
        }
      }
      return -1
    }

    const entrySize = is64 ? 16 : 8
    const dyn = Buffer.alloc(Math.min(dynSize, entrySize * 1024))
    fs.readSync(fd, dyn, 0, dyn.length, dynOff)
    const tags: Array<{ tag: number; val: number }> = []
    for (let o = 0; o + entrySize <= dyn.length; o += entrySize) {
      const tag = is64 ? Number(dyn.readBigInt64LE(o)) : dyn.readInt32LE(o)
      if (tag === 0) break // DT_NULL
      const val = is64 ? Number(dyn.readBigUInt64LE(o + 8)) : dyn.readUInt32LE(o + 4)
      tags.push({ tag, val })
    }

    const strtabVal = tags.find((t) => t.tag === 5)?.val // DT_STRTAB
    const neededVals = tags.filter((t) => t.tag === 1) // DT_NEEDED
    if (strtabVal === undefined) return neededVals.length > 0 ? null : []
    const strOff = vaddrToOff(strtabVal)
    if (strOff < 0) return null
    const strsz = tags.find((t) => t.tag === 10)?.val ?? 65536 // DT_STRSZ
    const strtab = Buffer.alloc(Math.min(strsz, 4 << 20))
    fs.readSync(fd, strtab, 0, strtab.length, strOff)

    const names: string[] = []
    for (const { val } of neededVals) {
      if (val < 0 || val >= strtab.length) continue
      const end = strtab.indexOf(0, val)
      const name = strtab.subarray(val, end === -1 ? undefined : end).toString('latin1')
      if (name) names.push(name)
    }
    return names
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Relative paths of every folder under `root` that ships *.prx (sce_sys skipped, depth ≤ 4). */
async function walkModuleDirs(root: string): Promise<string[]> {
  const dirs: string[] = []
  const visit = async (full: string, rel: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fsp.readdir(full, { withFileTypes: true })
    } catch {
      return
    }
    let hasPrx = false
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'sce_sys') continue
        await visit(path.join(full, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1)
      } else if (entry.name.endsWith('.prx') && !entry.name.endsWith('.guest.prx')) {
        hasPrx = true
      }
    }
    if (hasPrx && rel) dirs.push(rel)
  }
  await visit(root, '', 0)
  return dirs
}

export interface CompatReport {
  checks: CompatCheck[]
  /** False when any check has status 'fail' — installation must not start. */
  compatible: boolean
}

/**
 * Pre-install compatibility test: answers "will this dump convert?" before a
 * single game file is copied. Mirrors what the pipeline + relinker will do:
 * container detection, a trial SELF unwrap (catches encrypted/truncated
 * eboots immediately instead of at 55% of a real install), the libraries the
 * game depends on vs what the runtime provides (predicts launch problems),
 * tooling availability, and module-folder consistency (duplicate names,
 * backup leftovers — both auto-reconciled by the installer, reported as
 * warnings).
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
  } else {
    const bytes = readMagicHex(eboot)
    checks.push({
      id: 'eboot',
      label: 'Executable',
      status: 'fail',
      detail:
        bytes === 'empty' || bytes === 'unreadable'
          ? `eboot.bin is ${bytes} — the dump is incomplete; re-copy or re-extract it.`
          : `eboot.bin is not a recognized ELF or SELF file (first bytes: ${bytes}) — the file is truncated, corrupted, or not an eboot.`
    })
  }

  // ---- Python + trial unwrap (only relevant for SELF eboots) -------------
  let needed: string[] | null = null
  if (kind === 'self') {
    const python = await pythonInvocation()
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

    // A trial unwrap answers both questions that otherwise surface only at
    // 55% of a real install: does this eboot actually unwrap (encrypted or
    // truncated containers), and which libraries does the game ask for?
    if (python) {
      const trialDir = path.join(os.tmpdir(), `novaps5-compat-${process.pid}-${Date.now()}`)
      try {
        await fsp.mkdir(trialDir, { recursive: true })
        const outElf = path.join(trialDir, 'eboot.elf')
        await unwrapSelf(eboot, outElf)
        needed = readNeeded(outElf)
        checks.push({
          id: 'unwrap',
          label: 'Eboot unwrap',
          status: 'pass',
          detail: 'Trial unwrap succeeded — the executable converts cleanly.'
        })
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).replace(
          /^Unwrap failed — /,
          ''
        )
        checks.push({
          id: 'unwrap',
          label: 'Eboot unwrap',
          status: 'fail',
          detail: `The eboot cannot be converted: ${detail}`
        })
      } finally {
        await fsp.rm(trialDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  } else if (kind === 'elf') {
    needed = readNeeded(eboot)
  }

  // ---- Conversion runtime ------------------------------------------------
  const tools = toolingPresent()
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

  // ---- Module folders ----------------------------------------------------
  const hasSingular = fs.existsSync(path.join(root, 'sce_module'))
  const hasPlural = fs.existsSync(path.join(root, 'sce_modules'))
  const hasPrxDir = fs.existsSync(path.join(root, 'prx'))
  const moduleIssues: CompatCheck[] = []
  let moduleCount = 0
  const moduleFileNames = new Set<string>()

  if (!hasSingular && !hasPlural && !hasPrxDir) {
    moduleIssues.push({
      id: 'modules-none',
      label: 'Modules',
      status: 'fail',
      detail: 'No sce_module/ folder — this dump ships no loadable modules for the converter.'
    })
  } else {
    if (hasSingular && hasPlural) {
      // The relinker rejects both existing at once — the installer merges
      // sce_modules/ into sce_module/ on the staging copy instead of failing.
      moduleIssues.push({
        id: 'modules-both',
        label: 'Modules',
        status: 'warn',
        detail:
          'Both sce_module/ and sce_modules/ exist — sce_modules/ will be merged into sce_module/ automatically.'
      })
    }
    // Mirror the relinker's directory set: the root module folders it scans
    // plus every extra folder the installer hands over via --module-dir.
    const rootDirs = [
      hasSingular ? 'sce_module' : null,
      hasPlural ? 'sce_modules' : null,
      hasPrxDir ? 'prx' : null
    ].filter((dir): dir is string => dir !== null)
    const extraDirs = (await walkModuleDirs(root)).filter((dir) => !rootDirs.includes(dir))
    const dirs = [...rootDirs, ...extraDirs]

    interface ModuleFile {
      rel: string
      name: string
      magic: 'elf' | 'self'
    }
    const files: ModuleFile[] = []
    for (const rel of dirs) {
      let entries: import('fs').Dirent[]
      try {
        entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (entry.name.endsWith('.guest.prx')) continue // previous conversion output
        const magic = await fileMagic(path.join(root, rel, entry.name))
        if (magic === 'other') continue
        files.push({ rel, name: entry.name, magic })
        moduleFileNames.add(entry.name.toLowerCase())
      }
    }
    // Duplicate filenames (case-folded, as the converter folds names on
    // Windows). The installer resolves them automatically: keep the copy in
    // the primary folder (sce_module > sce_modules > prx > elsewhere) and
    // drop the rest from the staging copy — reported as a warning so the user
    // sees exactly what was reconciled.
    const byName = new Map<string, ModuleFile[]>()
    for (const file of files) {
      const folded = file.name.toLowerCase()
      const bucket = byName.get(folded)
      if (bucket) bucket.push(file)
      else byName.set(folded, [file])
    }
    for (const [, bucket] of byName) {
      if (bucket.length < 2) continue
      bucket.sort(
        (a, b) => moduleDirRank(a.rel) - moduleDirRank(b.rel) || a.rel.localeCompare(b.rel)
      )
      const locations = [...new Set(bucket.map((f) => `${f.rel}/${f.name}`))].join(' and ')
      moduleIssues.push({
        id: `modules-dup-${bucket[0].name.toLowerCase()}`,
        label: 'Modules',
        status: 'warn',
        detail: `Duplicate module "${bucket[0].name}" at ${locations} — the converter keeps the copy in ${bucket[0].rel}/ and skips the others.`
      })
    }

    // Backup leftovers — pruned automatically by the installer, reported so
    // the user sees exactly what was in the way. (.esbak is AnyPS5's own
    // unwrap backup convention and is always removed from the staging copy.)
    const backups = files.filter((file) => isBackupName(file.name) || file.name.endsWith('.esbak'))
    if (backups.length > 0) {
      const shown = backups.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(', ')
      const more = backups.length > 3 ? ` (+${backups.length - 3} more)` : ''
      moduleIssues.push({
        id: 'modules-backups',
        label: 'Modules',
        status: 'warn',
        detail: `Backup leftovers will be skipped during conversion: ${shown}${more}.`
      })
    }

    // Content-ELF files without a .prx name (not backups) — the converter
    // includes them anyway, so surface them instead of failing late.
    const strays = files.filter(
      (file) => !file.name.endsWith('.prx') && !isBackupName(file.name) && !file.name.endsWith('.esbak')
    )
    if (strays.length > 0) {
      const shown = strays.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(', ')
      const more = strays.length > 3 ? ` (+${strays.length - 3} more)` : ''
      moduleIssues.push({
        id: 'modules-strays',
        label: 'Modules',
        status: 'warn',
        detail: `Module-like files without a .prx name will still be converted: ${shown}${more}.`
      })
    }
    moduleCount = files.length - backups.length
  }

  if (moduleIssues.some((check) => check.status === 'fail')) {
    checks.push(...moduleIssues.filter((check) => check.status === 'fail'))
    // Non-fatal notes would only add noise next to a blocker.
  } else {
    const clean = moduleIssues.length === 0
    checks.push(
      ...moduleIssues,
      {
        id: 'modules',
        label: 'Modules',
        status: 'pass',
        detail: clean
          ? `${moduleCount} loadable module${moduleCount === 1 ? '' : 's'} found — folders are consistent.`
          : `${moduleCount} loadable module${moduleCount === 1 ? '' : 's'} found — the notes above are reconciled during conversion.`
      }
    )
  }

  // ---- Libraries the game depends on -------------------------------------
  if (needed && needed.length > 0 && tools.libs) {
    const provided = new Set<string>()
    try {
      for (const entry of fs.readdirSync(runtimeLibsDir(), { withFileTypes: true })) {
        if (entry.isFile()) provided.add(normalizeLibName(entry.name))
      }
    } catch {
      // A missing runtime is already reported by the runtime check above.
    }
    for (const name of moduleFileNames) provided.add(normalizeLibName(name))
    const missing = needed.filter((name) => !provided.has(normalizeLibName(name)))
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
            detail: `All ${needed.length} required librar${needed.length === 1 ? 'y is' : 'ies are'} provided by the runtime or the dump.`
          }
    )
  }

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
