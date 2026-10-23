import path from 'path'
import { run, extractFailure } from './run'
import { relinkerPath } from '../paths'

export interface RelinkResult {
  stdout: string
  stderr: string
  /**
   * SELF containers the relinker skipped instead of converting. The pipeline
   * unwraps every module it discovers, so anything listed here means a module
   * was missed (e.g. nested deeper than the discovery walk) and the game may
   * fail to launch.
   */
  skippedSelf: string[]
}

export interface RelinkOptions {
  onOutput?: (chunk: string) => void
  cwd?: string
  /** Extra module folders (relative to `cwd`) passed via --module-dir. */
  moduleDirs?: string[]
  /**
   * Guest module filenames to exclude from conversion (`--exclude-sce-module`).
   * Used to retry a failed conversion without the module that broke it.
   */
  excludeModules?: string[]
  /**
   * Embed AnyPS5's startup dependency diagnostics. When the game cannot
   * resolve a dll/import at launch, the probe log names the exact provider
   * and symbol instead of a bare crash code. On by default.
   */
  windowsDiagnostics?: boolean
}

/**
 * A relinker failure that kept the raw `FAIL:` detail. The installer uses the
 * detail to decide whether a retry without a specific module could succeed.
 */
export class RelinkError extends Error {
  readonly detail: string
  readonly output: string

  constructor(detail: string, output: string) {
    super(`Conversion failed — ${explainRelinkFailure(detail)}`)
    this.name = 'RelinkError'
    this.detail = detail
    this.output = output
  }
}

/**
 * Known relinker failures → plain-language explanations. The raw message is
 * never lost: anything unmatched falls through unchanged.
 */
function explainRelinkFailure(detail: string): string {
  const rules: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [
      /^Ambiguous guest dependency name: (.+)$/i,
      (m) =>
        `Two module files claim the name "${m[1]}" — usually a leftover backup copy (like *.bak) inside a module folder. Remove the duplicate file from the dump and retry.`
    ],
    [
      /^Conflicting guest output filename: (.+)$/i,
      (m) =>
        `Two modules would be written out as "${m[1]}" — remove one of the duplicate module files from the dump.`
    ],
    [
      /^Ambiguous guest module identity: (.+)$/i,
      (m) =>
        `Several modules identify as "${m[1]}" (same SONAME in different folders) — remove the duplicate copies from the dump.`
    ],
    [
      /^Unsupported (?:Windows )?guest filename: (.+)$/i,
      (m) =>
        `The module filename "${m[1]}" contains characters Windows cannot use — rename that module inside the dump and retry.`
    ],
    [
      /^Neither DT_OS_ nor DT_ variant present for DT_SYMTAB/i,
      () =>
        'The executable has no usable dynamic symbol table — it is not a standard PS5 ELF. Re-extract the dump; if it still fails, the eboot is unsupported.'
    ],
    [
      /^Both sce_module and sce_modules exist/i,
      () => 'The dump has both sce_module/ and sce_modules/ — keep only one of them.'
    ],
    [
      /^Guest module parent directory does not exist/i,
      () => 'The dump has no module folder and the converter could not create one — check that the games folder is writable and retry.'
    ],
    [
      /^Guest module path is not a directory: (.+)$/i,
      (m) => `The module folder "${m[1]}" is missing or is not a folder — retry the installation.`
    ],
    [
      /^Duplicate guest module directory: (.+)$/i,
      (m) =>
        `The module folder "${m[1]}" was passed more than once — retry the installation; the duplicate scan is automatic.`
    ],
    [
      /^Excluded guest module file not found/i,
      () => 'The dump layout changed mid-conversion — retry the installation.'
    ],
    [
      /cannot (?:read|open) (?:the )?(?:input|executable)/i,
      () => 'The unwrapped eboot could not be read — re-import the dump.'
    ]
  ]
  for (const [pattern, describe] of rules) {
    const match = detail.match(pattern)
    if (match) return describe(match)
  }
  return detail
}

/** SELF containers the relinker reports on stdout as skipped. */
function findSkippedSelf(stdout: string): string[] {
  const skipped: string[] = []
  const pattern = /Skipping SELF container:\s*([^\r\n]+)/gi
  for (let match = pattern.exec(stdout); match; match = pattern.exec(stdout)) {
    const name = match[1].replace(/\s*\([^)]*\)\s*$/, '').trim()
    if (name) skipped.push(name)
  }
  return skipped
}

/**
 * Run the AnyPS5 relinker to produce a Windows PE from a clean ELF.
 * On success the relinker also emits converted guest modules into
 * <outputDir>/app0/, preserving each module folder's relative path.
 */
export async function relink(
  inputElf: string,
  outputExe: string,
  options: RelinkOptions = {}
): Promise<RelinkResult> {
  // Extra module directories (PS4 titles ship loadable modules beside
  // sce_module, e.g. Media/Modules, Media/Plugins) are converted too, and
  // their outputs keep the relative path under app0.
  const args = ['--windows']
  if (options.windowsDiagnostics !== false) args.push('--windows-diagnostics')
  for (const dir of options.moduleDirs ?? []) args.push('--module-dir', dir)
  for (const name of options.excludeModules ?? []) args.push('--exclude-sce-module', name)
  args.push(inputElf, outputExe)

  const result = await run(relinkerPath(), args, {
    onOutput: options.onOutput,
    cwd: options.cwd,
    timeoutMs: 30 * 60 * 1000
  })

  if (result.timedOut) {
    throw new Error(
      `Conversion failed — the converter ran for over 30 minutes on ${path.basename(inputElf)} and was stopped. The dump may contain an unusually large executable.`
    )
  }
  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`
    const detail =
      extractFailure(output) ?? `relinker exited with code ${result.code}`
    throw new RelinkError(detail, output)
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    skippedSelf: findSkippedSelf(result.stdout)
  }
}
