import { defineConfig } from "vitest/config"

const isDeno = process.versions.deno !== undefined
const isBun = process.versions.bun !== undefined

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "packages/ai/*/vitest.config.ts",
      "packages/atom/*/vitest.config.ts",
      "packages/tools/*/vitest.config.ts",
      "packages/sql/*/vitest.config.ts",
      ...(isDeno ?
        [
          "!packages/atom",
          "!packages/platform-bun",
          "!packages/platform-node",
          "!packages/platform-node-shared",
          "!packages/sql/d1",
          "!packages/sql/sqlite-node"
        ] :
        []),
      ...(isBun ?
        [
          "!packages/platform-node"
        ] :
        [])
    ]
  }
})
