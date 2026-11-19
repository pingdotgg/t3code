/// <reference types="vite/client" />

interface Window {
  /** Present only inside Electron. */
  board?: { reportFirstPaint: (epochMs: number) => void };
}
