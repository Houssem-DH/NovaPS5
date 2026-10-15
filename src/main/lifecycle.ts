// Tiny shared flag so anything in the main process can let the window close for
// real instead of minimizing to the taskbar (quitting, or installing an update).
let quitting = false

export function beginQuit(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

/** Lets the window go back to close-means-minimize when a quit did not happen. */
export function cancelQuit(): void {
  quitting = false
}
