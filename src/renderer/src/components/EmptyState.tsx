import { useState } from 'react'
import { Gamepad2, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLibrary } from '@/store/useLibrary'
import { cn } from '@/lib/utils'

export function EmptyState() {
  const { setInstallOpen, scan } = useLibrary()
  const [scanning, setScanning] = useState(false)
  const [logoOk, setLogoOk] = useState(true)

  const runScan = async (): Promise<void> => {
    setScanning(true)
    await scan()
    setScanning(false)
  }

  return (
    <div className="flex min-h-[56vh] flex-col items-center justify-center text-center">
      {logoOk ? (
        <img
          src="logo.png"
          alt="NovaPS5"
          draggable={false}
          onError={() => setLogoOk(false)}
          className="brand-glow mb-4 h-auto w-52 select-none"
        />
      ) : (
        <div className="gradient-play mb-6 flex h-20 w-20 items-center justify-center rounded-2xl shadow-2xl shadow-primary/25">
          <Gamepad2 className="h-10 w-10 text-white" />
        </div>
      )}

      <h2 className="text-xl font-semibold tracking-tight">Your library is empty</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Install a PS5 game from a dump you own — the app unwraps it, converts it with the AnyPS5 relinker, sets it up to
        play, then verifies it launches. Already have games on disk? Scan for them.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" onClick={() => setInstallOpen(true)}>
          <Plus className="h-4 w-4" /> Install your first game
        </Button>
        <Button size="lg" variant="outline" onClick={runScan} disabled={scanning}>
          <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} />
          {scanning ? 'Scanning…' : 'Scan library'}
        </Button>
      </div>
    </div>
  )
}
