/// <reference types="vite/client" />

import type { FramekitApi } from './shared/types'

declare global {
  interface Window {
    framekit: FramekitApi
  }
}

export {}
