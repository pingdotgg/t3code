import { mergeConfig } from "vitest/config"
import shared from "../../../vitest.shared.ts"

export default mergeConfig(shared, {
  resolve: {
    conditions: ["browser"]
  },
  esbuild: {
    target: "es2022"
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"]
  }
})
