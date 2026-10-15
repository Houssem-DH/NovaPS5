import { AlertTriangle, ArrowUpRight, CheckCircle2, Download, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ReleaseNotes } from '@/components/ReleaseNotes'
import { useLibrary } from '@/store/useLibrary'

/**
 * Two appearances of the same dialog:
 *  - "What's new": opened automatically once after the app restarted into an
 *    update, showing the version that landed and its GitHub release notes.
 *  - Status: opened from the header control, showing the current update state.
 */
export function UpdateDialog(): JSX.Element {
  const { update, whatsNew, updateOpen, setUpdateOpen, checkUpdates, installUpdate, dismissWhatsNew, appInfo } =
    useLibrary()

  const open = Boolean(whatsNew) || updateOpen
  const status = update?.status ?? 'idle'
  const version = whatsNew?.version ?? update?.version
  const notes = (whatsNew?.notes || update?.notes || '').trim()
  const percent = update?.percent ?? 0
  const repo = appInfo?.appRepo
  const releaseUrl = repo && version ? `https://github.com/${repo}/releases/tag/v${version}` : null
  const currentVersion = update?.currentVersion ?? appInfo?.appVersion ?? ''
  if (!open) return <>{null}</>

  const close = (): void => {
    if (whatsNew) void dismissWhatsNew()
    setUpdateOpen(false)
  }

  const heading = whatsNew
    ? `Updated to NovaPS5 v${whatsNew.version}`
    : status === 'checking'
      ? 'Checking for updates'
      : status === 'current'
        ? "You're up to date"
        : status === 'error'
          ? 'Could not check for updates'
          : status === 'ready'
            ? `NovaPS5 v${version} is ready to install`
            : version
              ? `NovaPS5 v${version} is available`
              : 'Application updates'

  const blurb = whatsNew
    ? 'The app restarted into the new version. Here is what changed.'
    : status === 'checking'
      ? 'Looking for a newer NovaPS5 release on GitHub.'
      : status === 'current'
        ? `NovaPS5 v${currentVersion} is the newest release.`
        : status === 'error'
          ? (update?.detail ?? 'The update server could not be reached.')
          : status === 'downloading'
            ? `Downloading the update — ${percent}%. Nothing restarts on its own; you decide when to install it.`
            : status === 'ready'
              ? 'The update is downloaded and waiting. Restart to update when it suits you — NovaPS5 will not restart on its own.'
              : status === 'installing'
                ? 'Restarting to install the update. NovaPS5 will be back in a moment.'
                : 'Updates come from this app’s GitHub releases.'

  const Icon = whatsNew
    ? CheckCircle2
    : status === 'checking' || status === 'installing'
      ? Loader2
      : status === 'current'
        ? CheckCircle2
        : status === 'error'
          ? AlertTriangle
          : status === 'downloading' || status === 'ready'
            ? Download
            : Sparkles

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon
              className={`h-4 w-4 shrink-0 ${
                status === 'checking' || status === 'installing' ? 'animate-spin text-primary' : ''
              } ${status === 'error' && !whatsNew ? 'text-amber-400' : ''} ${whatsNew || status === 'current' ? 'text-emerald-400' : ''}`}
            />
            <span className="min-w-0 break-words">{heading}</span>
          </DialogTitle>
          <DialogDescription className="break-words">{blurb}</DialogDescription>
        </DialogHeader>

        {(status === 'downloading' || status === 'ready' || (status === 'installing' && !whatsNew)) && (
          <div className="space-y-1.5">
            <Progress value={status === 'ready' || status === 'installing' ? 100 : percent} />
            <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>{status === 'downloading' ? 'Downloading update' : 'Ready to restart'}</span>
              <span>{status === 'ready' || status === 'installing' ? 100 : percent}%</span>
            </div>
          </div>
        )}

        {notes && (
          <div className="rounded-xl border border-border/60 bg-card/50 p-4 text-xs leading-relaxed text-muted-foreground">
            {!whatsNew && <div className="section-label mb-2">What&apos;s new</div>}
            <ReleaseNotes text={notes} />
          </div>
        )}

        {!notes && whatsNew && (
          <p className="rounded-xl border border-border/60 bg-card/50 p-4 text-xs text-muted-foreground">
            NovaPS5 updated to v{whatsNew.version}. No release notes were published for this version.
          </p>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            {currentVersion ? `NovaPS5 v${currentVersion} · ` : ''}Nova Crafted
          </span>
          <div className="flex items-center gap-2">
            {releaseUrl && (
              <Button variant="ghost" size="sm" onClick={() => void window.api.openExternal(releaseUrl)}>
                <ArrowUpRight className="h-3.5 w-3.5" /> Release notes
              </Button>
            )}
            {whatsNew ? (
              <Button size="sm" onClick={close}>
                Got it
              </Button>
            ) : status === 'ready' || status === 'installing' ? (
              <Button size="sm" onClick={() => void installUpdate()}>
                <Download className="h-3.5 w-3.5" /> Restart to update
              </Button>
            ) : status === 'downloading' ? (
              <Button size="sm" disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Downloading…
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={close}>
                  Close
                </Button>
                <Button size="sm" onClick={() => void checkUpdates()}>
                  <RefreshCw className="h-3.5 w-3.5" /> Check again
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
