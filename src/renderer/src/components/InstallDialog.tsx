import { useEffect, useState } from 'react'
import { FolderOpen, FileArchive, Package, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { useLibrary } from '@/store/useLibrary'
import type { DetectResult } from '@shared/types'
import { formatBytes } from '@/lib/format'

export function InstallDialog() {
  const { installOpen, setInstallOpen, installing, setInstalling, load } = useLibrary()

  const [source, setSource] = useState<string | null>(null)
  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [name, setName] = useState('')

  const running = installing?.status === 'running'
  const done = installing?.status === 'done'
  const failed = installing?.status === 'error'

  const reset = (): void => {
    setSource(null)
    setDetect(null)
    setName('')
    setInstalling(null)
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open && !running) reset()
    setInstallOpen(open)
  }

  const pick = async (kind: 'folder' | 'archive'): Promise<void> => {
    const path = kind === 'folder' ? await window.api.selectFolder() : await window.api.selectArchive()
    if (!path) return
    setSource(path)
    setDetect(null)
    setScanning(true)
    const result = await window.api.detect(path)
    setScanning(false)
    setDetect(result)
    if (result.isDump && result.name) setName(result.name)
  }

  const start = async (): Promise<void> => {
    if (!source) return
    await window.api.install({ sourcePath: source, name: name.trim() || undefined })
  }

  useEffect(() => {
    if (!done) return
    load()
    const timer = setTimeout(() => {
      reset()
      setInstallOpen(false)
    }, 1800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  const showProgress = installing && (running || done || failed)

  return (
    <Dialog open={installOpen} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install a game</DialogTitle>
          <DialogDescription>
            Convert a PS5 dump you own into a playable Windows game — fully automated.
          </DialogDescription>
        </DialogHeader>

        {showProgress ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              {done ? (
                <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-400" />
              ) : failed ? (
                <AlertTriangle className="h-6 w-6 shrink-0 text-red-400" />
              ) : (
                <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {done ? 'Installed — ready to play' : failed ? 'Conversion failed' : installing?.message}
                </p>
                {installing?.gameName && done && (
                  <p className="truncate text-xs text-muted-foreground">{installing.gameName}</p>
                )}
                {failed && installing?.error && (
                  <p className="mt-1 break-all text-xs text-red-400/90">{installing.error}</p>
                )}
              </div>
              <span className="text-sm tabular-nums text-muted-foreground">
                {installing?.percent ?? 0}%
              </span>
            </div>

            <Progress value={installing?.percent ?? 0} className="h-3" />

            {!done && !failed && (
              <p className="text-xs text-muted-foreground">
                This can take a few minutes for large games. The app unwraps, relinks, and arranges everything
                automatically.
              </p>
            )}

            {done && (
              <Button variant="outline" className="w-full" onClick={() => { reset(); setInstallOpen(false) }}>
                Close
              </Button>
            )}
            {failed && (
              <Button variant="outline" className="w-full" onClick={reset}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => pick('folder')}
                disabled={scanning}
                className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-secondary/50 p-4 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-accent disabled:opacity-60"
              >
                <FolderOpen className="h-5 w-5 text-primary" />
                Select dump folder
              </button>
              <button
                onClick={() => pick('archive')}
                disabled={scanning}
                className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-secondary/50 p-4 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-accent disabled:opacity-60"
              >
                <FileArchive className="h-5 w-5 text-primary" />
                Select .zip archive
              </button>
            </div>

            {scanning && (
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/50 p-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Scanning source…
              </div>
            )}

            {detect && !detect.isDump && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{detect.reason}</span>
              </div>
            )}

            {detect?.isDump && (
              <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
                <div>
                  <div className="font-medium">{detect.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {detect.titleId ?? 'Unknown title ID'} · {formatBytes(detect.sizeBytes ?? 0)}
                    {detect.hasCover ? ' · cover art found' : ''}
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-sm font-medium">Name (editable)</span>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={detect.name} />
                </div>
              </div>
            )}

            {source && (
              <p className="truncate text-xs text-muted-foreground" title={source}>
                {source}
              </p>
            )}

            <Button className="w-full" size="lg" disabled={!detect?.isDump || scanning} onClick={start}>
              <Package className="h-4 w-4" /> Install
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
