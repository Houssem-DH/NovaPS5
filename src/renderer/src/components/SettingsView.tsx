import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CheckCircle2,
  Download,
  Folder,
  FolderOpen,
  Loader2,
  Package,
  RefreshCw,
  Terminal,
  Wrench,
  XCircle
} from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

function Row({
  icon: Icon,
  label,
  value,
  ok,
  action
}: {
  icon: typeof Folder
  label: string
  value: string
  ok?: boolean
  action?: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {label}
          {ok !== undefined &&
            (ok ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400" />
            ))}
        </div>
        <div className="mt-0.5 break-all text-xs text-muted-foreground">{value}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function SettingsView() {
  const { appInfo, refreshInfo } = useLibrary()
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [moving, setMoving] = useState(false)
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null)
  const [gamesMsg, setGamesMsg] = useState<string | null>(null)

  useEffect(() => {
    void refreshInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    await refreshInfo()
    setChecking(false)
  }

  const checkUpdates = async (): Promise<void> => {
    setUpdating(true)
    setRuntimeMsg(null)
    const result = await window.api.runBootstrap()
    setRuntimeMsg(
      result.ok
        ? result.updated
          ? `Runtime updated to v${result.runtimeVersion}.`
          : `Runtime v${result.runtimeVersion ?? 'bundled'} is up to date.`
        : (result.error ?? 'Update check failed.')
    )
    await refreshInfo()
    setUpdating(false)
  }

  const changeGamesDir = async (): Promise<void> => {
    const dir = await window.api.selectFolder()
    if (!dir) return
    if (dir === appInfo?.gamesDir) return
    setMoving(true)
    setGamesMsg(null)
    const result = await window.api.setGamesDir(dir)
    setGamesMsg(
      result.ok
        ? result.moved > 0
          ? `Games folder changed — ${result.moved} game${result.moved === 1 ? '' : 's'} moved.`
          : 'Games folder changed.'
        : (result.error ?? 'Could not change the games folder.')
    )
    await refreshInfo()
    setMoving(false)
  }

  const pythonOk = !!appInfo?.pythonPath
  const toolsOk = appInfo?.relinkerPresent && appInfo?.libsPresent
  const allOk = pythonOk && toolsOk

  return (
    <div className="max-w-2xl">
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Runtime updates, library locations, and tooling.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={checkUpdates} disabled={updating}>
            <Download className={cn('h-4 w-4', updating && 'animate-pulse')} />
            {updating ? 'Checking…' : 'Check for updates'}
          </Button>
          <Button variant="outline" size="sm" onClick={recheck} disabled={checking}>
            <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} /> Re-check
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'mb-5 flex items-center gap-2.5 rounded-xl border p-4 text-sm',
          allOk
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        )}
      >
        {allOk ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}
        {allOk
          ? 'Everything is ready — games can be converted and played.'
          : 'Some components are missing. Conversion may fail until they are resolved.'}
      </div>

      <div className="space-y-3">
        <Row
          icon={Package}
          label="Conversion runtime"
          value={
            appInfo?.runtimeVersion
              ? `v${appInfo.runtimeVersion} — github.com/${appInfo.runtimeRepo}`
              : 'Not installed yet — installs automatically on launch'
          }
          ok={toolsOk}
          action={
            <Button variant="outline" size="sm" onClick={checkUpdates} disabled={updating}>
              {updating && <Loader2 className="h-4 w-4 animate-spin" />}
              {updating ? 'Working…' : 'Update'}
            </Button>
          }
        />
        <Row
          icon={FolderOpen}
          label="Games folder"
          value={appInfo?.gamesDir ?? '…'}
          action={
            <Button variant="outline" size="sm" onClick={changeGamesDir} disabled={moving}>
              {moving && <Loader2 className="h-4 w-4 animate-spin" />}
              {moving ? 'Moving games…' : 'Change…'}
            </Button>
          }
        />
        <Row
          icon={Wrench}
          label="Relinker"
          value={appInfo?.relinkerPresent ? 'relinker.exe found' : 'relinker.exe missing — it installs automatically'}
          ok={appInfo?.relinkerPresent}
        />
        <Row
          icon={Wrench}
          label="Runtime libraries"
          value={appInfo?.libsPresent ? `${appInfo.toolsDir}\\libs` : 'libs/ folder missing'}
          ok={appInfo?.libsPresent}
        />
        <Row
          icon={Terminal}
          label="Python 3"
          value={pythonOk ? `Detected: ${appInfo?.pythonPath}` : 'Python 3 not found (needed for SELF unwrapping)'}
          ok={pythonOk}
        />
        <Row icon={Folder} label="Library folder" value={appInfo?.libraryRoot ?? '…'} />
        <Row icon={Folder} label="Tools folder" value={appInfo?.toolsDir ?? '…'} />
      </div>

      {runtimeMsg && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {runtimeMsg}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Changing the games folder relocates every already-installed game into the new location — large libraries can
        take a while.
      </p>
      {gamesMsg && (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {gamesMsg}
        </p>
      )}

      <Separator className="my-7" />

      <div className="text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground/80">How it works</p>
        <p className="mt-1">
          Each install unwraps the game&apos;s SELF modules to ELF, runs the AnyPS5 relinker to build a Windows
          executable, and arranges the <code className="rounded bg-secondary px-1">app0/</code> runtime layout.
          Conversion uses your local dump only — nothing is downloaded.
        </p>
      </div>
    </div>
  )
}
