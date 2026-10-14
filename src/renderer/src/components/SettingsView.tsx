import { useEffect, useState } from 'react'
import { Folder, Wrench, RefreshCw, CheckCircle2, XCircle, Terminal } from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

function Row({
  icon: Icon,
  label,
  value,
  ok
}: {
  icon: typeof Folder
  label: string
  value: string
  ok?: boolean
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
              <XCircle className="h-4 w-4 text-amber-400" />
            ))}
        </div>
        <div className="mt-0.5 break-all text-xs text-muted-foreground">{value}</div>
      </div>
    </div>
  )
}

export function SettingsView() {
  const { appInfo, refreshInfo } = useLibrary()
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void refreshInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    await refreshInfo()
    setChecking(false)
  }

  const pythonOk = !!appInfo?.pythonPath
  const toolsOk = appInfo?.relinkerPresent && appInfo?.libsPresent
  const allOk = pythonOk && toolsOk

  return (
    <div className="max-w-2xl">
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Conversion tooling and library locations.</p>
        </div>
        <Button variant="outline" size="sm" onClick={recheck} disabled={checking}>
          <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} /> Re-check
        </Button>
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
          icon={Wrench}
          label="Relinker"
          value={appInfo?.relinkerPresent ? 'relinker.exe found' : 'relinker.exe NOT found — run npm run setup:tools'}
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
