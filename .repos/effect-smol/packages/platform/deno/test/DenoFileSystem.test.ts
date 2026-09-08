import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem"
import { describe } from "@effect/vitest"
import { testLayer } from "../../../effect/test/FileSystem.test-utils.ts"

describe("FileSystem", () =>
  testLayer(DenoFileSystem.layer, {
    accessOnDirectory: false,
    tempFileScopedRemovesDirectory: false
  }))
