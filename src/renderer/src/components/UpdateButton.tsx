import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { cn } from '@/lib/utils'

/** Header control: app-update status, doubling as the "check now" button. */
export function UpdateButton(): JSX.Element {
  const { update, checkUpdates, setUpdateOpen } = useLibrary()

  const status = update?.status ?? 'idle'
  const percent = update?.percent ?? 0
  const version = update?.version
  const busy = status === 'checking' || status === 'downloading' || status === 'installing'
  const hasUpdate = status === 'available' || status === 'downloading' || status === 'ready' || status === 'installing'

  const view = (() => {
    switch (status) {
      case 'checking':
        return { icon: Loader2, label: 'Checking for updates…', tone: 'text-muted-foreground' }
      case 'current':
        return { icon: CheckCircle2, label: update?.message ?? 'Up to date', tone: 'text-emerald-400' }
      case 'available':
        return { icon: Sparkles, label: `v${version} available`, tone: 'text-primary' }
      case 'downloading':
        return { icon: Download, label: `Downloading ${percent}%`, tone: 'text-primary' }
      case 'ready':
        return { icon: Download, label: `Restart to update v${version}`, tone: 'text-primary' }
      case 'installing':
        return { icon: Loader2, label: 'Restarting to update…', tone: 'text-primary' }
      case 'error':
        return { icon: AlertTriangle, label: update?.message ?? 'Update check failed', tone: 'text-amber-400' }
      default:
        return { icon: RefreshCw, label: 'Check for updates', tone: 'text-muted-foreground' }
    }
  })()

  const Icon = view.icon

  const onClick = async (): Promise<void> => {
    if (hasUpdate || busy) {
      setUpdateOpen(true)
      return
    }
    await checkUpdates()
    const next = useLibrary.getState().update
    if (next?.version && (next.status === 'available' || next.status === 'downloading' || next.status === 'ready')) {
      setUpdateOpen(true)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      title={update?.detail ?? view.label}
      className={cn(
        'relative flex h-7 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-border/60 bg-card/70 px-2.5',
        'text-[11px] font-medium transition-colors hover:border-border hover:bg-accent/70',
        view.tone
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', status === 'checking' || status === 'installing' ? 'animate-spin' : '')} />
      <span className="hidden whitespace-nowrap sm:inline">{view.label}</span>
      {(status === 'downloading' || status === 'ready') && (
        <span className="absolute inset-x-1.5 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-primary/20">
          <span
            className="block h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${status === 'ready' ? 100 : percent}%` }}
          />
        </span>
      )}
    </button>
  )
}
