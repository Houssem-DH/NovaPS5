import { run, extractFailure } from './run'
import { relinkerPath } from '../paths'

export interface RelinkResult {
  stdout: string
  stderr: string
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
    throw new Error(`Conversion failed — ${detail}`)
  }

  return { stdout, stderr }
}
