import rule from "@effect/oxc/oxlint/rules/no-js-extension-imports"
import { describe, expect, it } from "vitest"
import { runRule } from "./utils.ts"

describe("no-js-extension-imports", () => {
  const createImportDeclaration = (source: string) => ({
    type: "ImportDeclaration",
    source: { value: source, range: [8, 8 + source.length + 2] as [number, number] },
    range: [0, 50] as [number, number]
  })

  const createExportAllDeclaration = (source: string) => ({
    type: "ExportAllDeclaration",
    source: { value: source, range: [14, 14 + source.length + 2] as [number, number] },
    range: [0, 50] as [number, number]
  })

  const createExportNamedDeclaration = (source: string) => ({
    type: "ExportNamedDeclaration",
    source: { value: source, range: [9, 9 + source.length + 2] as [number, number] },
    range: [0, 50] as [number, number]
  })

  describe("ImportDeclaration", () => {
    it("should report .js extension in relative imports", () => {
      const node = createImportDeclaration("./foo.js")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".ts" extension instead of ".js" for relative imports`)
    })

    it("should report .jsx extension in relative imports", () => {
      const node = createImportDeclaration("./component.jsx")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".tsx" extension instead of ".jsx" for relative imports`)
    })

    it("should report .mjs extension in relative imports", () => {
      const node = createImportDeclaration("../utils.mjs")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".mts" extension instead of ".mjs" for relative imports`)
    })

    it("should report .cjs extension in relative imports", () => {
      const node = createImportDeclaration("./config.cjs")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".cts" extension instead of ".cjs" for relative imports`)
    })

    it("should not report .ts extension in relative imports", () => {
      const node = createImportDeclaration("./foo.ts")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(0)
    })

    it("should not report .tsx extension in relative imports", () => {
      const node = createImportDeclaration("./component.tsx")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(0)
    })

    it("should not report for package imports with .js extension", () => {
      const node = createImportDeclaration("some-package/utils.js")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(0)
    })

    it("should not report for bare package imports", () => {
      const node = createImportDeclaration("effect")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(0)
    })

    it("should handle deeply nested relative imports", () => {
      const node = createImportDeclaration("../../lib/utils.js")
      const errors = runRule(rule, "ImportDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".ts" extension instead of ".js" for relative imports`)
    })
  })

  describe("ExportAllDeclaration", () => {
    it("should report .js extension in relative re-exports", () => {
      const node = createExportAllDeclaration("./foo.js")
      const errors = runRule(rule, "ExportAllDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".ts" extension instead of ".js" for relative imports`)
    })

    it("should not report .ts extension in relative re-exports", () => {
      const node = createExportAllDeclaration("./foo.ts")
      const errors = runRule(rule, "ExportAllDeclaration", node)
      expect(errors).toHaveLength(0)
    })
  })

  describe("ExportNamedDeclaration", () => {
    it("should report .js extension in relative named exports", () => {
      const node = createExportNamedDeclaration("./foo.js")
      const errors = runRule(rule, "ExportNamedDeclaration", node)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe(`Use ".ts" extension instead of ".js" for relative imports`)
    })

    it("should not report .ts extension in relative named exports", () => {
      const node = createExportNamedDeclaration("./foo.ts")
      const errors = runRule(rule, "ExportNamedDeclaration", node)
      expect(errors).toHaveLength(0)
    })

    it("should handle export without source", () => {
      const node = { type: "ExportNamedDeclaration", source: null }
      const errors = runRule(rule, "ExportNamedDeclaration", node)
      expect(errors).toHaveLength(0)
    })
  })
})
