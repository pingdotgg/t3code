import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"

const backendOrigin = process.env.VITE_BACKEND_ORIGIN ?? "http://127.0.0.1:8787"

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  server: {
    proxy: {
      "/api": {
        target: backendOrigin,
        changeOrigin: true
      },
      "/health": {
        target: backendOrigin,
        changeOrigin: true
      },
      "/ws": {
        target: backendOrigin,
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    outDir: "../public",
    emptyOutDir: true
  }
})
