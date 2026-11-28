import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { describe } from "@effect/vitest"
import { testLayer } from "../../../effect/test/FileSystem.test-utils.ts"

describe("FileSystem", { concurrent: false }, () => {
  testLayer(BunFileSystem.layer, { noFollow: process.platform !== "win32" })
})
