import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/store/useStore'

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

export function StoreSettingsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const regions = useStore((state) => state.regions)
  const settings = useStore((state) => state.settings)
  const saveSettings = useStore((state) => state.saveSettings)

  const [region, setRegion] = useState(settings?.region ?? 'GB')
  const [catalogUrl, setCatalogUrl] = useState(settings?.catalogUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRegion(settings?.region ?? 'GB')
    setCatalogUrl(settings?.catalogUrl ?? '')
    setError(null)
  }, [open, settings?.region, settings?.catalogUrl])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const match = regions.find((entry) => entry.code === region)
      await saveSettings({
        region,
        language: match?.language ?? 'en',
        catalogUrl: catalogUrl.trim() || null
      })
      onOpenChange(false)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Catalog settings</DialogTitle>
          <DialogDescription>
            Choose which PlayStation Store region to browse, and optionally point at a catalog you
            host yourself.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground/90">Region</span>
            <select
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {regions.map((entry) => (
                <option key={entry.code} value={entry.code} className="bg-card text-foreground">
                  {entry.label}
                </option>
              ))}
            </select>
            <span className="block text-[11px] text-muted-foreground">
              Availability and metadata come from this storefront.
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground/90">Self-hosted catalog</span>
            <Input
              value={catalogUrl}
              onChange={(event) => setCatalogUrl(event.target.value)}
              placeholder="https://my-server/games/catalog.json or C:\\Games\\catalog.json"
              spellCheck={false}
            />
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              Optional. A JSON file listing dumps you already have, with a download URL this PC is
              allowed to fetch. Entries appear first in the catalog and can be downloaded and
              installed in one click. See docs/store-catalog.md.
            </span>
          </label>

          {error ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
