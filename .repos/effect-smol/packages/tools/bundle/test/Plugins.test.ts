import { createResolveLocalPackageImports } from "@effect/bundle/Plugins"
import { assert, describe, it } from "@effect/vitest"
import type * as EffectPath from "effect/Path"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "rollup"

type Resolved = {
  readonly id: string
  readonly external: false
}

type ResolveId = (
  this: {
    readonly resolve: (
      source: string,
      importer?: string,
      options?: { readonly skipSelf?: boolean }
    ) => Promise<Resolved | null>
  },
  source: string,
  importer?: string
) => Promise<Resolved | null>

const packageDir = fileURLToPath(new URL("../../../effect", import.meta.url))
const pathService = path as unknown as EffectPath.Path

const getResolveId = (plugin: Plugin): ResolveId => {
  assert.strictEqual(typeof plugin.resolveId, "function")
  return plugin.resolveId as ResolveId
}

const resolved = (id: string): Resolved => ({
  id,
  external: false
})

describe("createResolveLocalPackageImports", () => {
  it("resolves directory package exports to dist index files", async () => {
    const resolveId = getResolveId(createResolveLocalPackageImports(pathService))
    const result = await resolveId.call({
      resolve: async (source) => {
        switch (source) {
          case "effect/package.json":
            return resolved(path.join(packageDir, "package.json"))
          case "effect/testing":
            return resolved(path.join(packageDir, "src", "testing", "index.ts"))
          default:
            return null
        }
      }
    }, "effect/testing")

    assert.deepStrictEqual(result, resolved(path.join(packageDir, "dist", "testing", "index.js")))
  })

  it("keeps flat package exports on flat dist files", async () => {
    const resolveId = getResolveId(createResolveLocalPackageImports(pathService))
    const result = await resolveId.call({
      resolve: async (source) => {
        switch (source) {
          case "effect/package.json":
            return resolved(path.join(packageDir, "package.json"))
          case "effect/Schema":
            return resolved(path.join(packageDir, "src", "Schema.ts"))
          default:
            return null
        }
      }
    }, "effect/Schema")

    assert.deepStrictEqual(result, resolved(path.join(packageDir, "dist", "Schema.js")))
  })
})
