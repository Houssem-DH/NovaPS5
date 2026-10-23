import { useEffect, useState } from 'react'
import {
  Check,
  Download,
  ExternalLink,
  FileArchive,
  FolderOpen,
  Gamepad2,
  Loader2,
  Play,
  Plus,
  Trash2
} from 'lucide-react'
import type { StoreGame } from '@shared/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useStore } from '@/store/useStore'
import { useLibrary } from '@/store/useLibrary'
import { formatBytes } from '@/lib/format'
import { GameGraphicsSettings } from './GameGraphics'

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

export function StoreGameDialog() {
  const game = useStore((state) => state.activeGame)
  const entries = useStore((state) => state.entries)
  const entry = game ? entries.find((candidate) => candidate.game.id === game.id) : undefined
  const progress = useStore((state) => (game ? state.progress[game.id] : undefined))
  const openGame = useStore((state) => state.openGame)
  const addToLibrary = useStore((state) => state.addToLibrary)
  const removeFromLibrary = useStore((state) => state.removeFromLibrary)
  const setDownloadUrl = useStore((state) => state.setDownloadUrl)
  const download = useStore((state) => state.download)
  const installLocal = useStore((state) => state.installLocal)
  const installedGame = useLibrary((state) => {
    const byId = entry?.installedGameId
      ? state.games.find((candidate) => candidate.id === entry.installedGameId)
      : undefined
    if (byId) return byId
    return game?.titleId
      ? state.games.find((candidate) => candidate.titleId === game.titleId)
      : undefined
  })

  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    // Only reset when a different game is opened; entry updates from a save
    // should not clobber what the user is typing.
    setUrl(entry?.game.downloadUrl ?? game?.downloadUrl ?? '')
    setActionError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id])

  if (!game) return null

  const running = progress?.status === 'running'
  const downloadUrl = entry?.game.downloadUrl ?? game.downloadUrl
  const hero = game.heroUrl ?? game.coverUrl
  const canDownload = Boolean(url.trim() || downloadUrl)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const ensureEntry = async (): Promise<void> => {
    if (!entry) await addToLibrary(game)
  }

  const startDownload = (): Promise<void> =>
    run(async () => {
      await ensureEntry()
      // Use a URL the user just typed even if they didn't press Save first.
      await download(game.id, url.trim() || downloadUrl || undefined)
    })

  const saveUrl = (): Promise<void> =>
    run(async () => {
      await ensureEntry()
      await setDownloadUrl(game.id, url.trim() || null)
    })

  const pickArchive = (): Promise<void> =>
    run(async () => {
      const source = await window.api.selectArchive()
      if (!source) return
      await ensureEntry()
      await installLocal(game.id, source)
    })

  const pickFolder = (): Promise<void> =>
    run(async () => {
      const source = await window.api.selectFolder()
      if (!source) return
      await ensureEntry()
      await installLocal(game.id, source)
    })

  const releaseYear = game.releaseDate ? new Date(game.releaseDate).getFullYear() : null

  return (
    <Dialog open onOpenChange={(open) => !open && openGame(null)}>
      <DialogContent className="max-h-[92vh] max-w-2xl gap-0 overflow-y-auto p-0 [&>button]:rounded-full [&>button]:bg-black/55 [&>button]:p-1.5 [&>button]:text-white [&>button]:opacity-90 [&>button]:backdrop-blur-sm">
        <div className="relative h-44 w-full shrink-0 overflow-hidden">
          {hero ? (
            <img src={hero} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="cover-fallback absolute inset-0" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/55 to-black/10" />
          <div className="absolute inset-x-6 bottom-4 flex items-end gap-4">
            <div className="h-28 w-20 shrink-0 overflow-hidden rounded-xl border border-white/15 bg-black/40 shadow-2xl shadow-black/50">
              {game.coverUrl ? (
                <img src={game.coverUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Gamepad2 className="h-7 w-7 text-white/25" />
                </div>
              )}
            </div>
            <DialogHeader className="min-w-0 pb-1">
              <DialogTitle className="truncate text-2xl">{game.name}</DialogTitle>
              <DialogDescription className="truncate">
                {game.publisher ?? 'PS5'}
                {releaseYear ? ` · ${releaseYear}` : ''}
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>

        <div className="space-y-5 p-6">
          <div className="flex flex-wrap items-center gap-2">
            {game.sizeBytes ? <Badge variant="outline">{formatBytes(game.sizeBytes)}</Badge> : null}
            {game.titleId ? <Badge variant="outline">{game.titleId}</Badge> : null}
            {game.genres.map((genre) => (
              <Badge key={genre} variant="outline">
                {genre}
              </Badge>
            ))}
            {installedGame ? (
              <Badge variant="success">
                <Check className="mr-1 h-3 w-3" /> Installed
              </Badge>
            ) : entry ? (
              <Badge>
                <Check className="mr-1 h-3 w-3" /> In library
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {installedGame ? (
              <Button
                onClick={() => window.api.launch(installedGame.id)}
                disabled={installedGame.status === 'error'}
                title={installedGame.status === 'error' ? installedGame.error : undefined}
              >
                <Play /> Play
              </Button>
            ) : null}

            {entry ? (
              <Button variant="outline" onClick={() => run(() => removeFromLibrary(game.id))}>
                <Trash2 /> Remove from library
              </Button>
            ) : (
              <Button onClick={() => run(() => addToLibrary(game))} disabled={busy}>
                <Plus /> Add to library
              </Button>
            )}

            <Button onClick={startDownload} disabled={busy || running || !canDownload}>
              {running ? <Loader2 className="animate-spin" /> : <Download />}
              Download &amp; install
            </Button>

            <Button variant="outline" onClick={pickArchive} disabled={busy || running}>
              <FileArchive /> Archive…
            </Button>
            <Button variant="outline" onClick={pickFolder} disabled={busy || running}>
              <FolderOpen /> Folder…
            </Button>

            {game.storeUrl ? (
              <Button variant="ghost" onClick={() => window.api.openExternal(game.storeUrl!)}>
                <ExternalLink /> PS Store page
              </Button>
            ) : null}
          </div>

          {installedGame && installedGame.status === 'ready' ? (
            <GameGraphicsSettings game={installedGame} />
          ) : null}

          {actionError ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-300">
              {actionError}
            </p>
          ) : null}

          {progress ? (
            <div className="space-y-2 rounded-xl border border-border/60 bg-secondary/30 p-4">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate font-medium">{progress.message}</span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(progress.percent)}%
                </span>
              </div>
              <Progress value={progress.percent} />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground">
                  {progress.status === 'error'
                    ? progress.error
                    : progress.receivedBytes
                      ? `${formatBytes(progress.receivedBytes)}${
                          progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''
                        }`
                      : progress.step}
                </span>
                {progress.status === 'running' && progress.step === 'downloading' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => window.api.storeCancelDownload(progress.jobId)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="rounded-xl border border-border/60 bg-secondary/20 p-4">
            <p className="text-xs font-semibold text-foreground/90">Have your own copy?</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Point at a download URL you host — an archive of a dump you already own — or install
              from a folder/archive on this PC. NovaPS5 never downloads game content from Sony or
              third-party game sources.
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://my-server/games/my-dump.zip"
                spellCheck={false}
              />
              <Button variant="outline" onClick={saveUrl} disabled={busy || url === (downloadUrl ?? '')}>
                Save
              </Button>
            </div>
            {downloadUrl ? (
              <p className="mt-2 truncate text-[11px] text-muted-foreground" title={downloadUrl}>
                Source: {downloadUrl}
              </p>
            ) : null}
          </div>

          {game.source === 'psn' ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Metadata comes from the public PlayStation Store catalog. To install, add a dump you
              own or a download URL you host. The game is yours to supply.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
