import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['cheerio']
      },
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    server: {
      watch: {
        ignored: ['**/release/**', '**/out/**', '**/.tmp/**']
      }
    },
    build: {
      rolldownOptions: {
        input: resolve(__dirname, 'index.html')
      }
    }
  }
})
