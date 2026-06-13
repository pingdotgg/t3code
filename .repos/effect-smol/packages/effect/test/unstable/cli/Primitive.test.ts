import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, PlatformError, Redacted } from "effect"
import { Primitive } from "effect/unstable/cli"

const FileSystemLayer = FileSystem.layerNoop({})
const PathLayer = Path.layer

const TestLayer = Layer.mergeAll(
  FileSystemLayer,
  PathLayer
)

// Helper functions to reduce repetition
const expectValidValues = <A>(
  primitive: Primitive.Primitive<A>,
  cases: Array<[string, A]>
) =>
  Effect.gen(function*() {
    for (const [input, expected] of cases) {
      const result = yield* primitive.parse(input)
      assert.strictEqual(result, expected)
    }
  })

const expectInvalidValues = <A>(
  primitive: Primitive.Primitive<A>,
  inputs: ReadonlyArray<string>,
  messages: ReadonlyArray<string>
) =>
  Effect.gen(function*() {
    for (let i = 0; i < inputs.length; i++) {
      const error = yield* Effect.flip(primitive.parse(inputs[i]))
      assert.strictEqual(error, messages[i])
    }
  })

const expectValidDates = (
  primitive: Primitive.Primitive<Date>,
  cases: Array<[string, (date: Date) => void]>
) =>
  Effect.gen(function*() {
    for (const [input, validator] of cases) {
      const result = yield* primitive.parse(input)
      assert.isTrue(result instanceof Date)
      validator(result)
    }
  }) as Effect.Effect<void, string, never>

describe("Primitive", () => {
  describe("boolean", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should parse true values correctly", () =>
        expectValidValues(Primitive.boolean, [
          ["true", true],
          ["1", true],
          ["y", true],
          ["yes", true],
          ["on", true]
        ]))

      it.effect("should parse false values correctly", () =>
        expectValidValues(Primitive.boolean, [
          ["false", false],
          ["0", false],
          ["n", false],
          ["no", false],
          ["off", false]
        ]))

      it.effect("should fail for invalid values", () =>
        expectInvalidValues(
          Primitive.boolean,
          ["invalid"],
          [`Expected "true" | "yes" | "on" | "1" | "y" | "false" | "no" | "off" | "0" | "n", got "invalid"`]
        ))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.boolean._tag, "Boolean")
      })
    })
  })

  describe("float", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should parse valid float values", () =>
        expectValidValues(Primitive.float, [
          ["42", 42],
          ["3.14", 3.14],
          ["-42.5", -42.5],
          ["0", 0],
          ["1e3", 1000]
        ]))

      it.effect("should fail for invalid values", () =>
        expectInvalidValues(Primitive.float, ["not-a-number"], [
          `Expected a string representing a finite number, got "not-a-number"`
        ]))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.float._tag, "Float")
      })
    })
  })

  describe("date", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should parse valid date values", () =>
        expectValidDates(Primitive.date, [
          // ISO date
          [
            "2024-01-15",
            (date) => {
              assert.strictEqual(date.toISOString().slice(0, 10), "2024-01-15")
            }
          ],
          // Full ISO datetime
          [
            "2024-01-15T12:30:45.123Z",
            (date) => {
              assert.strictEqual(date.toISOString(), "2024-01-15T12:30:45.123Z")
            }
          ],
          // With timezone offset
          [
            "2024-01-15T12:30:45+02:00",
            (date) => {
              assert.strictEqual(date.getUTCHours(), 10)
              assert.strictEqual(date.getUTCMinutes(), 30)
            }
          ]
        ]))

      it.effect("should fail for invalid values", () =>
        expectInvalidValues(Primitive.date, ["not-a-date"], [`Expected a valid date, got Invalid Date`]))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.date._tag, "Date")
      })
    })
  })

  describe("integer", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should parse valid integer values", () =>
        expectValidValues(Primitive.integer, [
          ["42", 42],
          ["-123", -123],
          ["0", 0],
          ["9007199254740991", 9007199254740991],
          ["1e3", 1000]
        ]))

      it.effect("should fail for invalid values", () =>
        expectInvalidValues(
          Primitive.integer,
          ["3.14", "not-a-number"],
          [`Expected an integer, got 3.14`, `Expected a string representing a finite number, got "not-a-number"`]
        ))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.integer._tag, "Integer")
      })
    })
  })

  describe("string", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should parse string values", () =>
        expectValidValues(Primitive.string, [
          ["hello", "hello"],
          ["", ""],
          [" spaces ", " spaces "],
          ["123", "123"],
          ["special!@#$%", "special!@#$%"]
        ]))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.string._tag, "String")
      })
    })
  })

  describe("choice", () => {
    const colorChoice = Primitive.choice([
      ["red", "RED"],
      ["green", "GREEN"],
      ["blue", "BLUE"]
    ])

    it.layer(TestLayer)((it) => {
      it.effect("should parse valid choices", () =>
        expectValidValues(colorChoice, [
          ["red", "RED"],
          ["green", "GREEN"],
          ["blue", "BLUE"]
        ]))

      it.effect("should fail for invalid choices", () =>
        expectInvalidValues(
          colorChoice,
          ["yellow", "purple", ""],
          [
            `Expected "red" | "green" | "blue", got "yellow"`,
            `Expected "red" | "green" | "blue", got "purple"`,
            `Expected "red" | "green" | "blue", got ""`
          ]
        ))

      it("should have correct _tag", () => {
        assert.strictEqual(colorChoice._tag, "Choice")
      })

      const numberChoice = Primitive.choice([
        ["one", 1],
        ["two", 2],
        ["three", 3]
      ])

      it.effect("should work with different value types", () =>
        expectValidValues(numberChoice, [
          ["one", 1],
          ["two", 2],
          ["three", 3]
        ]))
    })
  })

  describe("path", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should resolve paths without requiring existence", () =>
        Effect.gen(function*() {
          const pathPrimitive = Primitive.path("either")
          const result1 = yield* pathPrimitive.parse("./test.txt")
          const result2 = yield* pathPrimitive.parse("/absolute/path")
          const result3 = yield* pathPrimitive.parse("relative/path")

          // Results should be absolute paths
          assert.isTrue(result1.includes("test.txt"))
          assert.isTrue(result2 === "/absolute/path")
          assert.isTrue(result3.includes("relative/path"))
        }))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.path("either")._tag, "Path")
      })

      it.effect("should fail when a required file path does not exist", () =>
        Effect.gen(function*() {
          const filePath = Primitive.path("file", true)

          // Test non-existent file - should fail validation
          const error = yield* Effect.flip(
            filePath.parse("/non/existent/file.txt")
          )

          assert.strictEqual(error, "Path does not exist: /non/existent/file.txt")
        }).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              stat: (path) =>
                Effect.fail(
                  PlatformError.badArgument({
                    module: "",
                    method: "",
                    description: `The specified path ${path} does not exist`
                  })
                )
            })
          )
        ))

      it.effect("should fail when a required directory path does not exist", () =>
        Effect.gen(function*() {
          const dirPath = Primitive.path("directory", true)

          // Test non-existent directory - should fail validation
          const error = yield* Effect.flip(
            dirPath.parse("/non/existent/directory")
          )

          assert.strictEqual(error, "Path does not exist: /non/existent/directory")
        }).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              stat: (path) =>
                Effect.fail(
                  PlatformError.badArgument({
                    module: "",
                    method: "",
                    description: `The specified path ${path} does not exist`
                  })
                )
            })
          )
        ))
    })
  })

  describe("redacted", () => {
    it.layer(TestLayer)((it) => {
      it.effect("should parse and redact values", () =>
        Effect.gen(function*() {
          const result = yield* Primitive.redacted.parse("secret123")
          // Check if it's a Redacted value
          assert.isTrue(Redacted.isRedacted(result))
          // The toString method should return a redacted representation
          assert.strictEqual(String(result), "<redacted>")
        }))

      it("should have correct _tag", () => {
        assert.strictEqual(Primitive.redacted._tag, "Redacted")
      })

      it.effect("should handle empty strings", () =>
        Effect.gen(function*() {
          const result = yield* Primitive.redacted.parse("")
          assert.isTrue(Redacted.isRedacted(result))
        }))
    })
  })
})
