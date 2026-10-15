import { ArrowLeft, Play, Trash2, Gamepad2, FolderOpen, AlertTriangle } from 'lucide-react'
import { selectedGame, useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { formatBytes, timeAgo } from '@/lib/format'

function Meta({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm text-foreground/90">{value}</dd>
    </div>
  )
}

export function GameDetail() {
  const { select, launch, remove } = useLibrary()
  const game = selectedGame()

  if (!game) return null
  const cover = window.api.coverUrl(game)

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => select(null)} className="-ml-2 mb-6">
        <ArrowLeft className="h-4 w-4" /> Back to library
      </Button>

      <div className="flex flex-col gap-9 md:flex-row">
        <div className="w-full max-w-[15rem] shrink-0 md:max-w-xs">
          <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-border/60 shadow-2xl shadow-black/40">
            {cover ? (
              <img src={cover} alt={game.name} draggable={false} className="h-full w-full object-cover" />
            ) : (
              <div className="cover-fallback flex h-full w-full items-center justify-center">
                <Gamepad2 className="h-14 w-14 text-muted-foreground/30" />
              </div>
            )}
          </div>
        </div>

        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {game.status === 'error' ? (
              <Badge variant="destructive">
                <AlertTriangle className="mr-1 h-3 w-3" /> Files missing
              </Badge>
            ) : (
              <Badge variant="success">Ready to play</Badge>
            )}
            {game.launchState === 'works' && <Badge variant="success">Launch test passed</Badge>}
            {game.launchState === 'failed' && <Badge variant="destructive">Launch test failed</Badge>}
            {game.titleId && <Badge variant="secondary">{game.titleId}</Badge>}
          </div>

          <h1 className="mt-3 text-3xl font-semibold tracking-tight">{game.name}</h1>

          {game.status === 'error' && game.error && (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {game.error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" variant="play" onClick={() => launch(game.id)}>
              <Play className="h-4 w-4" fill="currentColor" /> Play
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => {
                remove(game.id)
              }}
            >
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          </div>

          <Separator className="my-7" />

          <dl className="grid max-w-2xl grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            <Meta label="Size on disk" value={formatBytes(game.sizeBytes)} />
            <Meta label="Title ID" value={game.titleId ?? 'Unknown'} />
            <Meta label="Installed" value={timeAgo(game.installedAt)} />
            <Meta label="Last played" value={timeAgo(game.lastPlayedAt)} />
            {game.launchState && (
              <Meta
                label="Launch test"
                wide
                value={
                  game.launchState === 'works'
                    ? 'Passed — the game started and kept running.'
                    : `Failed — ${game.launchDetail ?? 'the game did not start.'}`
                }
              />
            )}
            <Meta label="Install folder" value={game.installPath} wide />
          </dl>

          <div className="panel mt-6 flex items-start gap-2.5 p-3.5 text-xs text-muted-foreground">
            <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="break-all">{game.exePath}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
