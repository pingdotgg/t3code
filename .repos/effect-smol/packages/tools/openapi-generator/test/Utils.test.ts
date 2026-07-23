import * as Utils from "@effect/openapi-generator/Utils"
import { describe, expect, it } from "vitest"

describe("Utils", () => {
  describe("camelize", () => {
    it("removes hyphens and capitalizes following letters", () => {
      expect(Utils.camelize("my-operation-id")).toBe("myOperationId")
    })

    it("removes slashes and capitalizes following letters", () => {
      expect(Utils.camelize("my/operation/id")).toBe("myOperationId")
    })

    it("handles numbers", () => {
      expect(Utils.camelize("operation-2")).toBe("operation2")
    })

    it("removes leading numbers", () => {
      expect(Utils.camelize("2operation")).toBe("operation")
    })

    it("handles empty string", () => {
      expect(Utils.camelize("")).toBe("")
    })
  })

  describe("identifier", () => {
    it("capitalizes camelized string", () => {
      expect(Utils.identifier("my-operation")).toBe("MyOperation")
      expect(Utils.identifier("operation-2")).toBe("Operation2")
    })
  })
})
