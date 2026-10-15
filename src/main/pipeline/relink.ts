import { run, extractFailure } from './run'
import { relinkerPath } from '../paths'

export interface RelinkResult {
  stdout: string
  stderr: string
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
      (m) => `Several modules identify as "${m[1]}" — remove the duplicate copies from the dump.`
    ],
    [
      /^Both sce_module and sce_modules exist/i,
      () => 'The dump has both sce_module/ and sce_modules/ — keep only one of them.'
    ],
    [
      /^Guest module parent directory does not exist/i,
      () => 'No sce_module/ folder was found — this dump ships no loadable modules for the converter.'
    ],
    [
      /^Excluded guest module file not found/i,
      () => 'The dump layout changed mid-conversion — retry the installation.'
    ]
  ]
  for (const [pattern, describe] of rules) {
    const match = detail.match(pattern)
    if (match) return describe(match)
  }
  return detail
}

/**
 * Run the AnyPS5 relinker to produce a Windows PE from a clean ELF.
 * On success the relinker also emits converted guest modules into
 * <outputDir>/app0/sce_module.
 */
export async function relink(
  inputElf: string,
  outputExe: string,
  onOutput?: (chunk: string) => void,
  cwd?: string,
  moduleDirs: string[] = []
): Promise<RelinkResult> {
  // Extra module directories (PS4 titles ship loadable modules beside
  // sce_module, e.g. Media/Modules, Media/Plugins) are converted too, and
  // their outputs keep the relative path under app0.
  const args = ['--windows']
  for (const dir of moduleDirs) args.push('--module-dir', dir)
  args.push(inputElf, outputExe)

  const { code, stdout, stderr } = await run(
    relinkerPath(),
    args,
    { onOutput, cwd, timeoutMs: 30 * 60 * 1000 }
  )

  if (code !== 0) {
    const detail = extractFailure(`${stderr}\n${stdout}`) ?? `relinker exited with code ${code}`
    throw new Error(`Conversion failed — ${explainRelinkFailure(detail)}`)
  }

  return { stdout, stderr }
}
