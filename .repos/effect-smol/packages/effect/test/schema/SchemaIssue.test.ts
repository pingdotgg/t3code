import { SchemaIssue } from "effect"
import { describe, it } from "vitest"
import { assertFalse, assertTrue } from "../utils/assert.ts"

describe("SchemaIssue", () => {
  it("isIssue", () => {
    assertTrue(SchemaIssue.isIssue(new SchemaIssue.MissingKey(undefined)))
    assertFalse(SchemaIssue.isIssue({ "~effect/SchemaIssue/Issue": false }))
  })
})
