import { playwright } from "@vitest/browser-playwright"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "@tanstack/react-router",
      "@effect/atom-react",
      "vitest-browser-react",
      "effect/unstable/reactivity/Atom",
      "effect/unstable/reactivity/AsyncResult"
    ]
  },
  test: {
    include: ["test/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [
        {
          browser: "chromium"
        }
      ]
    }
  }
})
