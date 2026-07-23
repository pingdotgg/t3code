import { Optic, Schema } from "effect"
import type { Option, Result } from "effect"
import { describe, expect, it } from "tstyche"

describe("Optic", () => {
  describe("key", () => {
    it("should not be allowed on union types", () => {
      type S = { readonly _tag: "A"; readonly a?: string } | { readonly _tag: "B"; readonly a?: number }
      expect(Optic.id<S>().key).type.not.toBeCallableWith("_tag")
    })

    it("optional key (with undefined)", () => {
      type S = { readonly a?: number | undefined }
      const optic = Optic.id<S>().key("a")

      expect(optic).type.toBe<Optic.Lens<S, number | undefined>>()
    })
  })

  describe("optionalKey", () => {
    it("should not be allowed on union types", () => {
      type S = { readonly _tag: "A"; readonly a?: string } | { readonly _tag: "B"; readonly a?: number }
      expect(Optic.id<S>().key).type.not.toBeCallableWith("a")
    })

    describe("Struct", () => {
      it("exact optional key (without undefined)", () => {
        type S = { readonly a?: number }
        const optic = Optic.id<S>().optionalKey("a")

        expect(optic).type.toBe<Optic.Lens<S, number | undefined>>()
      })
    })

    it("Record", () => {
      type S = { [x: string]: number }
      const optic = Optic.id<S>().optionalKey("a")

      expect(optic).type.toBe<Optic.Lens<S, number | undefined>>()
    })

    describe("Tuple", () => {
      it("exact optional element (without undefined)", () => {
        type S = readonly [number, number?]
        const optic = Optic.id<S>().optionalKey(1)

        expect(optic).type.toBe<Optic.Lens<S, number | undefined>>()
      })
    })

    it("Array", () => {
      type S = ReadonlyArray<number>
      const optic = Optic.id<S>().optionalKey(1)

      expect(optic).type.toBe<Optic.Lens<S, number | undefined>>()
    })
  })

  describe("at", () => {
    it("should not be allowed on union types", () => {
      type S =
        | Record<string, string>
        | Record<string, number>

      expect(Optic.id<S>().at).type.not.toBeCallableWith("a")
    })
  })

  describe("pick", () => {
    it("should not be allowed on union types", () => {
      type S = { readonly _tag: "A"; readonly a?: string } | { readonly _tag: "B"; readonly a?: number }
      expect(Optic.id<S>().pick).type.not.toBeCallableWith(["a"])
    })

    it("Struct", () => {
      type S = { readonly a: string; readonly b: number; readonly c: boolean }
      const optic = Optic.id<S>().pick(["a", "c"])

      expect(optic).type.toBe<Optic.Lens<S, { readonly a: string; readonly c: boolean }>>()
    })
  })

  describe("omit", () => {
    it("should not be allowed on union types", () => {
      type S = { readonly _tag: "A"; readonly a?: string } | { readonly _tag: "B"; readonly a?: number }
      expect(Optic.id<S>().omit).type.not.toBeCallableWith(["a"])
    })

    it("Struct", () => {
      type S = { readonly a: string; readonly b: number; readonly c: boolean }
      const optic = Optic.id<S>().omit(["b"])

      expect(optic).type.toBe<Optic.Lens<S, { readonly a: string; readonly c: boolean }>>()
    })
  })

  it("notUndefined", () => {
    const optic = Optic.id<number | undefined>().notUndefined()
    expect(optic).type.toBe<Optic.Prism<number | undefined, number>>()
  })

  it("fromChecks", () => {
    const optic = Optic.id<number>().compose(Optic.fromChecks(Schema.isGreaterThan(0), Schema.isInt()))
    expect(optic).type.toBe<Optic.Prism<number, number>>()
  })

  describe("Option", () => {
    it("some", () => {
      const optic = Optic.id<Option.Option<number>>().compose(Optic.some())
      expect(optic).type.toBe<Optic.Prism<Option.Option<number>, number>>()
    })

    it("none", () => {
      const optic = Optic.id<Option.Option<number>>().compose(Optic.none())
      expect(optic).type.toBe<Optic.Prism<Option.Option<number>, undefined>>()
    })
  })

  describe("Result", () => {
    it("success", () => {
      const optic = Optic.id<Result.Result<number, string>>().compose(Optic.success())
      expect(optic).type.toBe<Optic.Prism<Result.Result<number, string>, number>>()
    })

    it("failure", () => {
      const optic = Optic.id<Result.Result<number, string>>().compose(Optic.failure())
      expect(optic).type.toBe<Optic.Prism<Result.Result<number, string>, string>>()
    })
  })
})
