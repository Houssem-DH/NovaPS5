import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': shared
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve('src/preload'),
        '@shared': shared
      }
    }
  },
  renderer: {
    // Project-level public/ (logo, icon, favicon) — not the default
    // src/renderer/public, which doesn't exist.
    publicDir: resolve('public'),
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react()]
  }
})
