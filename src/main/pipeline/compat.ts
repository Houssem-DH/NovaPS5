import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { detectContainer, readMagicHex } from './elf'
import { readMeta } from './dump'
import { findPython } from '../python'
import { toolingPresent } from '../paths'
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
 * container detection, tooling availability, module-folder consistency
 * (duplicate names, backup leftovers the relinker would pick up by content).
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

  // ---- Python (only needed for SELF unwrap) ------------------------------
  if (kind === 'self') {
    const python = await findPython()
    checks.push(
      python
        ? {
            id: 'python',
            label: 'Python',
            status: 'pass',
            detail: 'Python 3 available for the SELF unwrap step.'
          }
        : {
            id: 'python',
            label: 'Python',
            status: 'fail',
            detail: 'Python 3 is required to unwrap SELF containers — install it from python.org.'
          }
    )
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

  if (hasSingular && hasPlural) {
    moduleIssues.push({
      id: 'modules-both',
      label: 'Modules',
      status: 'fail',
      detail: 'The dump has both sce_module/ and sce_modules/ — keep only one of them.'
    })
  } else if (!hasSingular && !hasPlural && !hasPrxDir) {
    moduleIssues.push({
      id: 'modules-none',
      label: 'Modules',
      status: 'fail',
      detail: 'No sce_module/ folder — this dump ships no loadable modules for the converter.'
    })
  } else {
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
      }
    }
    // Duplicate filenames (case-folded, as the converter folds names on
    // Windows) — two files claiming one name is a guaranteed conflict.
    const byName = new Map<string, ModuleFile[]>()
    for (const file of files) {
      const folded = file.name.toLowerCase()
      const bucket = byName.get(folded)
      if (bucket) bucket.push(file)
      else byName.set(folded, [file])
    }
    for (const [, bucket] of byName) {
      if (bucket.length < 2) continue
      const locations = [...new Set(bucket.map((f) => `${f.rel}/${f.name}`))].join(' and ')
      moduleIssues.push({
        id: `modules-dup-${bucket[0].name.toLowerCase()}`,
        label: 'Modules',
        status: 'fail',
        detail: `Duplicate module "${bucket[0].name}" found at ${locations} — remove one copy so the converter can tell them apart.`
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
    checks.push(
      ...moduleIssues,
      {
        id: 'modules',
        label: 'Modules',
        status: 'pass',
        detail: `${moduleCount} loadable module${moduleCount === 1 ? '' : 's'} found — folders are consistent.`
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
