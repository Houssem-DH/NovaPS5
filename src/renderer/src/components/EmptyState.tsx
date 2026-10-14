import { Gamepad2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLibrary } from '@/store/useLibrary'

export function EmptyState() {
  const { setInstallOpen } = useLibrary()

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="gradient-play mb-6 flex h-20 w-20 items-center justify-center rounded-2xl shadow-2xl shadow-primary/25">
        <Gamepad2 className="h-10 w-10 text-white" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">Your library is empty</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Install a PS5 game from a dump you own. The app unwraps it, converts it with the AnyPS5 relinker, and sets it
        up to play — hands-off.
      </p>
      <Button size="lg" className="mt-6" onClick={() => setInstallOpen(true)}>
        <Plus className="h-4 w-4" /> Install your first game
      </Button>
    </div>
  )
}
