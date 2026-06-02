import { mergeConfig } from "vitest/config"
import shared from "../../../vitest.shared.ts"

export default mergeConfig(shared, {
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"]
  }
})
