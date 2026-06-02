/**
 * Testing utilities for asserting Schema decoding, encoding, make, and
 * arbitrary-generation behavior. Used in unit tests to verify that schemas
 * accept, reject, and round-trip values correctly.
 *
 * ## Mental model
 *
 * - **Asserts** – entry point: wraps a schema and exposes helpers grouped by
 *   operation (decoding, encoding, make, arbitrary, round-trip).
 * - **Decoding** – returned by `asserts.decoding()`; has `succeed` / `fail`
 *   helpers that run the schema's decoder and compare the result.
 * - **Encoding** – returned by `asserts.encoding()`; mirrors {@link Decoding}
 *   but exercises the encoder direction.
 * - Every assertion is async (`Promise<void>`) because parsing may involve
 *   effectful schemas.
 * - `succeed` with one argument asserts identity (output equals input);
 *   with two arguments asserts a specific expected output.
 * - `fail` always takes the input and the expected error message string.
 *
 * ## Common tasks
 *
 * - Assert decoding succeeds / fails → `new Asserts(schema).decoding().succeed(…)` / `.fail(…)`
 * - Assert encoding succeeds / fails → `new Asserts(schema).encoding().succeed(…)` / `.fail(…)`
 * - Assert make succeeds / fails → `new Asserts(schema).make().succeed(…)` / `.fail(…)`
 * - Verify round-trip (encode then decode) → `new Asserts(schema).verifyLosslessTransformation()`
 * - Verify arbitrary generation → `new Asserts(schema).arbitrary().verifyGeneration()`
 * - Compare AST of struct fields → `Asserts.ast.fields.equals(a, b)`
 * - Provide a service dependency for decoding → `asserts.decoding().provide(key, impl)`
 *
 * ## Gotchas
 *
 * - `succeed` uses `assert.deepStrictEqual`, so reference equality is not
 *   required but structural equality is.
 * - `fail` compares against the stringified `Issue`, not the `Issue` object
 *   itself. Pass the exact multiline string the issue produces.
 * - `verifyLosslessTransformation` and `arbitrary().verifyGeneration` run
 *   property-based tests via FastCheck; default run count is 20 for
 *   `verifyGeneration`.
 *
 * ## Quickstart
 *
 * **Example** (Basic decoding and encoding assertions)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const schema = Schema.NumberFromString
 * const asserts = new TestSchema.Asserts(schema)
 *
 * // decoding
 * const decoding = asserts.decoding()
 * await decoding.succeed("1", 1)
 * await decoding.fail(null, "Expected string, got null")
 *
 * // encoding
 * const encoding = asserts.encoding()
 * await encoding.succeed(1, "1")
 * ```
 *
 * ## See also
 *
 * - {@link Asserts}
 * - {@link Decoding}
 * - {@link Encoding}
 *
 * @since 4.0.0
 */
import * as assert from "node:assert"
import type * as Context from "../Context.ts"
import * as Effect from "../Effect.ts"
import * as Record from "../Record.ts"
import * as Result from "../Result.ts"
import * as Schema from "../Schema.ts"
import * as AST from "../SchemaAST.ts"
import type * as Issue from "../SchemaIssue.ts"
import * as Parser from "../SchemaParser.ts"
import * as FastCheck from "../testing/FastCheck.ts"

/**
 * Provides schema test assertions for decoding, encoding, make, arbitrary generation, and round-trip verification.
 *
 * **When to use**
 *
 * Use when writing schema unit tests for decoding, encoding, construction, property-based round-trip, or generation behavior.
 *
 * **Example** (Decoding and encoding a struct)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const schema = Schema.Struct({ name: Schema.String })
 * const asserts = new TestSchema.Asserts(schema)
 *
 * // decoding
 * await asserts.decoding().succeed({ name: "Alice" })
 *
 * // encoding
 * await asserts.encoding().succeed({ name: "Alice" })
 * ```
 *
 * @see {@link Decoding}
 * @see {@link Encoding}
 * @category testing
 * @since 4.0.0
 */
export class Asserts<S extends Schema.Top> {
  /**
   * Static helpers for comparing schema AST structures.
   *
   * **When to use**
   *
   * Use to assert that two schema field or tuple element definitions produce
   * the same AST structure.
   *
   * **Details**
   *
   * `ast.fields.equals(a, b)` compares struct field ASTs via `assert.deepStrictEqual`. `ast.elements.equals(a, b)` compares tuple element ASTs via `assert.deepStrictEqual`.
   *
   * **Example** (Comparing struct fields)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const fieldsA = { name: Schema.String }
   * const fieldsB = { name: Schema.String }
   * TestSchema.Asserts.ast.fields.equals(fieldsA, fieldsB) // no error
   * ```
   */
  static ast = {
    fields: {
      equals: (a: Schema.Struct.Fields, b: Schema.Struct.Fields) => {
        assert.deepStrictEqual(Record.map(a, AST.getAST), Record.map(b, AST.getAST))
      }
    },
    elements: {
      equals: (a: Schema.Tuple.Elements, b: Schema.Tuple.Elements) => {
        assert.deepStrictEqual(a.map(AST.getAST), b.map(AST.getAST))
      }
    }
  } as const

  readonly schema: S
  constructor(schema: S) {
    this.schema = schema
  }
  /**
   * Returns an object with `succeed` and `fail` helpers for testing the schema's `make` operation.
   *
   * **When to use**
   *
   * Use to assert how `Schema.make` accepts, transforms, or rejects
   * construction input for this schema.
   *
   * **Details**
   *
   * `succeed(input)` asserts make returns the input unchanged. `succeed(input, expected)` asserts make returns `expected`. `fail(input, message)` asserts make fails with `message`.
   *
   * **Example** (Testing make)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const schema = Schema.String
   * const asserts = new TestSchema.Asserts(schema)
   * await asserts.make().succeed("hello")
   * ```
   *
   * @see {@link decoding} for assertions against decoded input
   * @see {@link encoding} for assertions against encoded output
   */
  make(options?: Schema.MakeOptions) {
    const makeEffect = Parser.makeEffect(this.schema)
    async function succeed(input: S["Type"]): Promise<void>
    async function succeed(input: S["~type.make.in"], expected: S["Type"]): Promise<void>
    async function succeed(input: S["~type.make.in"], expected?: S["Type"]) {
      const r = await Effect.runPromise(
        makeEffect(input, options).pipe(
          Effect.mapErrorEager((issue) => issue.toString()),
          Effect.result
        )
      )
      expected = arguments.length === 1 ? input : expected
      assert.deepStrictEqual(r, Result.succeed(expected))
    }
    return {
      succeed,
      async fail(input: unknown, message: string) {
        const r = await Effect.runPromise(
          makeEffect(input, options).pipe(
            Effect.mapErrorEager((issue) => issue.toString()),
            Effect.result
          )
        )
        assert.deepStrictEqual(r, Result.fail(message))
      }
    }
  }
  /**
   * Runs a property-based test that encodes arbitrary values and then decodes them, asserting the decoded value equals the original.
   *
   * **When to use**
   *
   * Use to verify that generated schema values survive an encode-then-decode
   * round trip.
   *
   * **Details**
   *
   * FastCheck generates arbitrary values matching the schema's `Type`. The assertion fails if any generated value does not round-trip. Pass `options.params` to control FastCheck parameters such as `numRuns`.
   *
   * **Example** (Round-trip verification)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * await asserts.verifyLosslessTransformation()
   * ```
   *
   * @see {@link arbitrary} for checking that generated values satisfy the schema
   */
  verifyLosslessTransformation<S extends Schema.Codec<unknown, unknown>>(this: Asserts<S>, options?: {
    readonly params?: FastCheck.Parameters<[S["Type"]]>
  }) {
    const decodeUnknownEffect = Parser.decodeUnknownEffect(this.schema)
    const encodeEffect = Parser.encodeEffect(this.schema)
    const arbitrary = Schema.toArbitrary(this.schema)
    return FastCheck.assert(
      FastCheck.asyncProperty(arbitrary, async (t) => {
        const r = await Effect.runPromise(
          encodeEffect(t).pipe(
            Effect.flatMapEager((e) => decodeUnknownEffect(e)),
            Effect.mapErrorEager((issue) => issue.toString()),
            Effect.result
          )
        )
        assert.deepStrictEqual(r, Result.succeed(t))
      }),
      options?.params
    )
  }
  /**
   * Returns a {@link Decoding} instance for this schema with helpers for decoding assertions.
   *
   * **When to use**
   *
   * Use to test how unknown input is decoded into the schema's type.
   *
   * **Details**
   *
   * Pass `parseOptions` to control error reporting, for example `{ errors: "all" }`.
   *
   * **Example** (Decoding assertions)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * const decoding = asserts.decoding()
   * await decoding.succeed("42", 42)
   * await decoding.fail(null, "Expected string, got null")
   * ```
   *
   * @see {@link Decoding}
   * @see {@link encoding} for assertions in the opposite direction
   */
  decoding(options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    return new Decoding(this.schema, options)
  }
  /**
   * Returns an {@link Encoding} instance for this schema with helpers for encoding assertions.
   *
   * **When to use**
   *
   * Use to test how schema values are encoded into their external form.
   *
   * **Details**
   *
   * Pass `parseOptions` to control error reporting, for example `{ errors: "all" }`.
   *
   * **Example** (Encoding assertions)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * const encoding = asserts.encoding()
   * await encoding.succeed(42, "42")
   * ```
   *
   * @see {@link Encoding}
   * @see {@link decoding} for assertions in the opposite direction
   */
  encoding(options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    return new Encoding(this.schema, options)
  }
  /**
   * Returns an object with property-based testing helpers for the schema's arbitrary generator.
   *
   * **When to use**
   *
   * Use to verify that arbitrary values generated for this schema satisfy the
   * schema's predicate.
   *
   * **Details**
   *
   * `verifyGeneration()` generates arbitrary values and asserts each value satisfies the schema's `is` predicate. It defaults to 20 runs. Pass `options.params` to override FastCheck parameters.
   *
   * **Example** (Verifying arbitrary generation)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.String)
   * asserts.arbitrary().verifyGeneration()
   * ```
   *
   * @see {@link verifyLosslessTransformation} for property-based round-trip checks
   */
  arbitrary<S extends Schema.Codec<unknown, unknown, never, unknown>>(this: Asserts<S>) {
    const schema = this.schema
    return {
      verifyGeneration(options?: {
        readonly params?: FastCheck.Parameters<[S["Type"]]> | undefined
      }) {
        const params = options?.params
        const is = Schema.is(schema)
        const arb = Schema.toArbitrary(schema)
        FastCheck.assert(FastCheck.property(arb, (a) => is(a)), { numRuns: 20, ...params })
      }
    }
  }
}

/**
 * Provides decoding test assertions through `succeed` and `fail` methods that run the schema's decoder and compare the result.
 *
 * **When to use**
 *
 * Use when you want to assert that specific inputs decode to expected values, invalid inputs produce specific error messages, or schemas receive required decoding services.
 *
 * **Details**
 *
 * All assertions are async and use `assert.deepStrictEqual` internally. `succeed(input)` asserts the decoded output equals `input`; `succeed(input, expected)` asserts it equals `expected`; `fail(input, message)` asserts decoding fails and the stringified issue equals `message`. `provide(key, impl)` returns a new `Decoding` with the service injected into the decoding context.
 *
 * **Example** (Decoding with service provision)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const asserts = new TestSchema.Asserts(Schema.String)
 * const decoding = asserts.decoding()
 * await decoding.succeed("hello")
 * ```
 *
 * @see {@link Asserts}
 * @see {@link Encoding}
 * @category testing
 * @since 4.0.0
 */
export class Decoding<S extends Schema.Top> {
  readonly schema: S
  readonly decodeUnknownEffect: (
    input: unknown,
    options?: AST.ParseOptions
  ) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]>
  readonly options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  } | undefined
  constructor(schema: S, options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    this.schema = schema
    this.decodeUnknownEffect = Parser.decodeUnknownEffect(schema)
    this.options = options
  }
  /**
   * Asserts that decoding `input` succeeds. With one argument, asserts the
   * output equals the input. With two arguments, asserts the output equals
   * `expected`.
   *
   * **When to use**
   *
   * Use to verify successful decoding for one input case.
   *
   * **Example** (Identity and transformed decoding)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const decoding = new TestSchema.Asserts(Schema.NumberFromString).decoding()
   * await decoding.succeed("1", 1) // transformed
   * ```
   *
   * @see {@link fail} for asserting decoding failures
   */
  async succeed<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown
  ): Promise<void>
  async succeed<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    expected: S["Type"]
  ): Promise<void>
  async succeed<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    expected?: S["Type"]
  ) {
    const r = await Effect.runPromise(
      this.decodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager((issue) => issue.toString()),
        Effect.result
      )
    )
    expected = arguments.length === 1 ? input : expected
    assert.deepStrictEqual(r, Result.succeed(expected))
  }
  /**
   * Asserts that decoding `input` fails and the stringified issue equals
   * `message`.
   *
   * **When to use**
   *
   * Use to verify that invalid decoding input produces the expected issue text.
   *
   * **Example** (Asserting a decoding failure)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const decoding = new TestSchema.Asserts(Schema.String).decoding()
   * await decoding.fail(42, "Expected string, got 42")
   * ```
   *
   * @see {@link succeed} for asserting successful decoding
   */
  async fail<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    message: string
  ) {
    const r = await Effect.runPromise(
      this.decodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager((issue) => issue.toString()),
        Effect.result
      )
    )
    assert.deepStrictEqual(r, Result.fail(message))
  }
  /**
   * Returns a new {@link Decoding} instance with the given service injected into the decoding effect context.
   *
   * **When to use**
   *
   * Use when the schema's decoder requires a service dependency.
   *
   * @see {@link Encoding.provide}
   */
  provide<Id, Service>(
    service: Context.Key<Id, Service>,
    implementation: Service
  ): Decoding<Schema.middlewareDecoding<S, Exclude<S["DecodingServices"], Id>>> {
    return new Decoding(
      this.schema.pipe(Schema.middlewareDecoding(Effect.provideService(service, implementation))),
      this.options
    )
  }
}

/**
 * Provides encoding test assertions through `succeed` and `fail` methods that run the schema's encoder and compare the result.
 *
 * **When to use**
 *
 * Use when you want to assert that specific values encode to expected outputs, invalid inputs produce specific error messages, or schemas receive required encoding services.
 *
 * **Details**
 *
 * All assertions are async and use `assert.deepStrictEqual` internally. `succeed(input)` asserts the encoded output equals `input`; `succeed(input, expected)` asserts it equals `expected`; `fail(input, message)` asserts encoding fails and the stringified issue equals `message`. `provide(key, impl)` returns a new `Encoding` with the service injected into the encoding context.
 *
 * **Example** (Encoding assertions)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
 * await encoding.succeed(42, "42")
 * ```
 *
 * @see {@link Asserts}
 * @see {@link Decoding}
 *
 * @category testing
 * @since 4.0.0
 */
export class Encoding<S extends Schema.Top> {
  readonly schema: S
  readonly encodeUnknownEffect: (
    input: unknown,
    options?: AST.ParseOptions
  ) => Effect.Effect<S["Type"], Issue.Issue, S["EncodingServices"]>
  readonly options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  } | undefined
  constructor(schema: S, options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    this.schema = schema
    this.encodeUnknownEffect = Parser.encodeUnknownEffect(schema)
    this.options = options
  }
  /**
   * Asserts that encoding `input` succeeds. With one argument, asserts the
   * output equals the input. With two arguments, asserts the output equals
   * `expected`.
   *
   * **When to use**
   *
   * Use to verify successful encoding for one input case.
   *
   * **Example** (Identity and transformed encoding)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
   * await encoding.succeed(1, "1") // transformed
   * ```
   *
   * @see {@link fail} for asserting encoding failures
   */
  async succeed<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown
  ): Promise<void>
  async succeed<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    expected: S["Encoded"]
  ): Promise<void>
  async succeed<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    expected?: S["Encoded"]
  ) {
    const r = await Effect.runPromise(
      this.encodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager((issue) => issue.toString()),
        Effect.result
      )
    )
    expected = arguments.length === 1 ? input : expected
    assert.deepStrictEqual(r, Result.succeed(expected))
  }
  /**
   * Asserts that encoding `input` fails and the stringified issue equals
   * `message`.
   *
   * **When to use**
   *
   * Use to verify that invalid encoding input produces the expected issue text.
   *
   * **Example** (Asserting an encoding failure)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
   * await encoding.fail("not-a-number", "Expected number, got \"not-a-number\"")
   * ```
   *
   * @see {@link succeed} for asserting successful encoding
   */
  async fail<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    message: string
  ) {
    const r = await Effect.runPromise(
      this.encodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager((issue) => issue.toString()),
        Effect.result
      )
    )
    assert.deepStrictEqual(r, Result.fail(message))
  }
  /**
   * Returns a new {@link Encoding} instance with the given service injected into the encoding effect context.
   *
   * **When to use**
   *
   * Use when the schema's encoder requires a service dependency.
   *
   * @see {@link Decoding.provide}
   */
  provide<Id, Service>(
    service: Context.Key<Id, Service>,
    implementation: Service
  ): Encoding<Schema.middlewareEncoding<S, Exclude<S["EncodingServices"], Id>>> {
    return new Encoding(
      this.schema.pipe(Schema.middlewareEncoding(Effect.provideService(service, implementation))),
      this.options
    )
  }
}
