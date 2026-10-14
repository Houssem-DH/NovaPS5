// Dev-only smoke test: runs the real install pipeline under Electron so all
// paths (Documents library, bundled tools, temp) match production exactly.
//
//   npx esbuild scripts/smoke-entry.ts --bundle --platform=node --format=cjs \
//     --external:electron --alias:@shared=./src/shared --outfile=scripts/.smoke.cjs
//   npx electron scripts/.smoke.cjs "<dump-folder>" ["Display Name"]
import { app } from 'electron'
import path from 'path'
import { installGame } from '../src/main/pipeline/install'

// The harness entry sits in scripts/, but getAppPath() must point at the
// project root so tools/ resolves exactly like production (electron-vite dev
// launches electron with the project directory).
app.setAppPath(path.resolve(__dirname, '..'))

const source = process.argv[2]
const name = process.argv[3]

if (!source) {
  console.error('usage: electron .smoke.cjs <dump-folder> [name]')
  app.exit(2)
}

app.whenReady().then(async () => {
  try {
    const game = await installGame(
      source,
      name,
      (p) => {
        const label = p.status === 'error' ? ` ERROR ${p.error ?? ''}` : ''
        process.stdout.write(`[${String(p.percent).padStart(3, '0')}%] ${p.step}: ${p.message}${label}\n`)
      },
      'smoke'
    )
    console.log(
      'SMOKE OK ' +
        JSON.stringify(
          { id: game.id, name: game.name, titleId: game.titleId, exe: game.exePath, size: game.sizeBytes, cover: game.cover },
          null,
          2
        )
    )
    app.exit(0)
  } catch (error) {
    console.error('SMOKE FAILED:', error instanceof Error ? error.message : String(error))
    app.exit(1)
  }
})
