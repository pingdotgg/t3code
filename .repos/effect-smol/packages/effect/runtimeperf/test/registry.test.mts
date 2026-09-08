import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { loadRegistry } from "../utils.mts"

describe("runtimeperf registry", () => {
  it("uses unique fixture targets and valid implementations", () => {
    const { fixtures } = loadRegistry()
    assert.equal(new Set(fixtures.map((fixture) => fixture.target)).size, fixtures.length)
    for (const fixture of fixtures) {
      assert.ok(["effect", "valibot", "zod4"].includes(fixture.implementation))
    }
  })

  it("keeps the focused Schema diagnostics Effect-only", () => {
    const { fixtures } = loadRegistry()
    const diagnostics = fixtures.filter((fixture) => fixture.suite === "schema")
    assert.ok(diagnostics.length > 0)
    assert.equal(diagnostics.every((fixture) => fixture.implementation === "effect"), true)
  })

  it("includes the complete effect@beta Schema Benchmarks matrix", () => {
    const { fixtures } = loadRegistry()
    assert.deepEqual(
      fixtures
        .filter((fixture) => fixture.suite === "schema-benchmarks" && fixture.implementation === "effect")
        .map((fixture) => fixture.name)
        .sort(),
      [
        "codec-typed-decode",
        "codec-typed-encode",
        "codec-unknown-decode",
        "codec-unknown-encode",
        "initialization-decoder",
        "initialization-schema",
        "parsing-all-invalid",
        "parsing-all-valid",
        "parsing-first-invalid",
        "parsing-first-valid",
        "standard-all-invalid",
        "standard-all-valid",
        "standard-first-invalid",
        "standard-first-valid",
        "validation-invalid",
        "validation-valid"
      ]
    )
  })

  it("includes the complete Valibot and Zod Schema Benchmarks matrices", () => {
    const { fixtures } = loadRegistry()
    const names = (implementation) =>
      fixtures
        .filter((fixture) => fixture.suite === "schema-benchmarks" && fixture.implementation === implementation)
        .map((fixture) => fixture.name)
        .sort()
    assert.deepEqual(names("valibot"), [
      "initialization-schema-valibot",
      "parsing-all-invalid-valibot",
      "parsing-all-valid-valibot",
      "parsing-first-invalid-valibot",
      "parsing-first-valid-valibot",
      "standard-all-invalid-valibot",
      "standard-all-valid-valibot",
      "validation-invalid-valibot",
      "validation-valid-valibot"
    ])
    assert.deepEqual(names("zod4"), [
      "codec-typed-decode-zod4",
      "codec-typed-encode-zod4",
      "initialization-schema-zod4",
      "parsing-all-invalid-zod4",
      "parsing-all-valid-zod4",
      "standard-all-invalid-zod4",
      "standard-all-valid-zod4"
    ])
  })

  it("uses Zod 4 standard and jitless safeParse for the zod4 fixtures", async () => {
    const { fixtures } = loadRegistry()
    const zodFiles = new Set(
      fixtures
        .filter((fixture) => fixture.implementation === "zod4")
        .map((fixture) => fixture.fixturePath)
    )
    assert.ok(zodFiles.size > 0)
    for (const path of zodFiles) {
      const source = await readFile(path, "utf8")
      assert.match(source, /from "zod\/v4"/)
      assert.doesNotMatch(source, /from "zod\/v4-mini"/)
      assert.match(source, /jitless:\s*true/)
    }
  })

  it("loads, runs and validates every fixture export", async () => {
    const { fixtures } = loadRegistry()
    const modules = new Map()
    for (const fixture of fixtures) {
      let module = modules.get(fixture.fixturePath)
      if (module === undefined) {
        module = await import(pathToFileURL(fixture.fixturePath))
        modules.set(fixture.fixturePath, module)
      }
      assert.equal(typeof module[fixture.export], "function", fixture.target)
      const runtimeCase = module[fixture.export]()
      const result = runtimeCase.run()
      assert.equal(typeof result?.then, "undefined", fixture.target)
      runtimeCase.validate(result)
    }
  })
})
