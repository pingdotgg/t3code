import { SchemaTransformation } from "effect"
import { describe, it } from "vitest"
import { assertFalse, assertTrue } from "../utils/assert.ts"

describe("SchemaTransformation", () => {
  it("isTransformation", () => {
    assertTrue(SchemaTransformation.isTransformation(SchemaTransformation.passthrough()))
    assertFalse(SchemaTransformation.isTransformation({ "~effect/SchemaTransformation/Transformation": false }))
  })
})
