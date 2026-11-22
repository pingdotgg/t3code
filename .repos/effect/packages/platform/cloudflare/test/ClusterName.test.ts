import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import { assert, describe, it } from "@effect/vitest"

describe("ClusterName", () => {
  it("length-prefixes the entity type", () => {
    assert.strictEqual(CloudflareCluster.encodeName("User", "42"), "4:User42")
  })

  it("round-trips encoded names", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["User", "42"],
      ["Counter", "a:b"],
      ["A:B", "X"],
      ["User", ""],
      ["Workflow123", "9:already-prefixed"]
    ]
    for (const [type, id] of cases) {
      assert.deepStrictEqual(
        CloudflareCluster.decodeName(CloudflareCluster.encodeName(type, id)),
        { type, id }
      )
    }
  })

  it("rejects names encodeName cannot produce", () => {
    const names = ["", "User42", ":User", "4User42", "10:User42", "5:User", "04:User42", "0:whatever"]
    for (const name of names) {
      assert.isUndefined(CloudflareCluster.decodeName(name), name)
    }
  })
})
