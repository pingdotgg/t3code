/**
 * Provides helpers for testing Schema behavior.
 *
 * These utilities assert how schemas construct values, decode input, encode
 * output, generate arbitrary values, and round-trip between encoded and decoded
 * forms. The `Asserts` class groups the common checks for one schema, while
 * `Decoding` and `Encoding` can be used directly when a test only needs one
 * direction.
 *
 * @since 4.0.0
 */
import * as assert from "node:assert"
import { isDeepStrictEqual } from "node:util"
import type * as Context from "../Context.ts"
import * as Effect from "../Effect.ts"
import { pipe } from "../Function.ts"
import * as Result from "../Result.ts"
import * as Schema from "../Schema.ts"
import * as SchemaAST from "../SchemaAST.ts"
import * as SchemaIssue from "../SchemaIssue.ts"
import * as SchemaParser from "../SchemaParser.ts"
import * as Arbitrary from "../unstable/arbitrary/Arbitrary.ts"

function assertPropertyPassed<A, E>(result: Arbitrary.CheckResult<A, E>): void {
  const failure = Arbitrary.formatCheckFailure(result)
  if (failure !== undefined) assert.fail(failure)
}

/**
 * Provides schema test assertions for decoding, encoding, make, arbitrary generation, and round-trip verification.
 *
 * **When to use**
 *
 * Use when writing schema unit tests for decoding, encoding, construction, property-based round-trip, or generation behavior.
 *
 * **Example** (Decoding and encoding a struct)
 *
 * ```ts import.meta.vitest
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const schema = Schema.Struct({ name: Schema.String })
 * const asserts = new TestSchema.Asserts(schema)
 *
 * // decoding
 * await asserts.decoding().succeed({ name: "Alice" }) // => undefined
 *
 * // encoding
 * await asserts.encoding().succeed({ name: "Alice" }) // => undefined
 * ```
 *
 * @see {@link Decoding}
 * @see {@link Encoding}
 * @category testing
 * @since 4.0.0
 */
export class Asserts<S extends Schema.Constraint> {
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
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const fieldsA = { name: Schema.String }
   * const fieldsB = { name: Schema.String }
   * TestSchema.Asserts.ast.fields.equals(fieldsA, fieldsB) // => undefined
   * ```
   */
  static ast = {
    fields: {
      equals: (a: Schema.Struct.Fields, b: Schema.Struct.Fields) => {
        assert.deepStrictEqual(
          Object.fromEntries(Reflect.ownKeys(a).map((key) => [key, SchemaAST.getAST(a[key])])),
          Object.fromEntries(Reflect.ownKeys(b).map((key) => [key, SchemaAST.getAST(b[key])]))
        )
      }
    },
    elements: {
      equals: (a: Schema.Tuple.Elements, b: Schema.Tuple.Elements) => {
        assert.deepStrictEqual(a.map(SchemaAST.getAST), b.map(SchemaAST.getAST))
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
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const schema = Schema.String
   * const asserts = new TestSchema.Asserts(schema)
   * await asserts.make().succeed("hello") // => undefined
   * ```
   *
   * @see {@link decoding} for assertions against decoded input
   * @see {@link encoding} for assertions against encoded output
   */
  make(options?: Schema.MakeOptions) {
    const makeEffect = SchemaParser.makeEffect(this.schema)
    async function succeed(input: S["Type"]): Promise<void>
    async function succeed(input: S["~type.make.in"], expected: S["Type"]): Promise<void>
    async function succeed(input: S["~type.make.in"], expected?: S["Type"]) {
      const r = await Effect.runPromise(
        makeEffect(input, options).pipe(
          Effect.mapErrorEager(SchemaIssue.defaultFormatter),
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
            Effect.mapErrorEager(SchemaIssue.defaultFormatter),
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
   * The native Schema arbitrary generates values matching the schema's `Type`. The assertion fails with the minimized
   * shrunk input and replay token if any generated value does not round-trip.
   *
   * **Example** (Verifying round trips)
   *
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.String)
   * await asserts.verifyLosslessTransformation({ seed: 1, runs: 20 }) // => undefined
   * ```
   *
   * @see {@link arbitrary} for checking that generated values satisfy the schema
   */
  verifyLosslessTransformation<S extends Schema.ConstraintCodec<unknown, unknown>>(
    this: Asserts<S>,
    options?: Arbitrary.CheckOptions
  ): Promise<void> {
    const decodeUnknownEffect = SchemaParser.decodeUnknownEffect(this.schema)
    const encodeEffect = SchemaParser.encodeEffect(this.schema)
    const arbitrary = Arbitrary.schema(this.schema)
    return Effect.runPromise(Arbitrary.checkEffect(
      arbitrary,
      (value) =>
        encodeEffect(value).pipe(
          Effect.flatMapEager((encoded) => decodeUnknownEffect(encoded)),
          Effect.mapErrorEager(SchemaIssue.defaultFormatter),
          Effect.result,
          Effect.mapEager((result) => isDeepStrictEqual(result, Result.succeed(value)))
        ),
      options
    )).then(assertPropertyPassed)
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
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * const decoding = asserts.decoding()
   * await decoding.succeed("42", 42) // => undefined
   * await decoding.fail(null, "Expected string") // => undefined
   * ```
   *
   * @see {@link Decoding}
   * @see {@link encoding} for assertions in the opposite direction
   */
  decoding(options?: {
    readonly parseOptions?: SchemaAST.ParseOptions | undefined
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
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * const encoding = asserts.encoding()
   * await encoding.succeed(42, "42") // => undefined
   * ```
   *
   * @see {@link Encoding}
   * @see {@link decoding} for assertions in the opposite direction
   */
  encoding(options?: {
    readonly parseOptions?: SchemaAST.ParseOptions | undefined
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
   * `verifyGeneration()` generates arbitrary values and asserts each value satisfies the schema's `is` predicate. It
   * defaults to 20 runs. Native checking options can control generation, shrinking, bounded discards, and replay.
   *
   * **Example** (Verifying arbitrary generation)
   *
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.String)
   * asserts.arbitrary().verifyGeneration({ seed: 1, runs: 20 }) // => undefined
   * ```
   *
   * @see {@link verifyLosslessTransformation} for property-based round-trip checks
   */
  arbitrary<S extends Schema.ConstraintCodec<unknown, unknown>>(this: Asserts<S>) {
    const schema = this.schema
    return {
      verifyGeneration(options?: Arbitrary.CheckOptions): void {
        const is = Schema.is(schema)
        const arbitrary = Arbitrary.schema(schema)
        assertPropertyPassed(Effect.runSync(Arbitrary.checkEffect(arbitrary, is, { runs: 20, ...options })))
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
 * ```ts import.meta.vitest
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const asserts = new TestSchema.Asserts(Schema.String)
 * const decoding = asserts.decoding()
 * await decoding.succeed("hello") // => undefined
 * ```
 *
 * @see {@link Asserts}
 * @see {@link Encoding}
 * @category testing
 * @since 4.0.0
 */
export class Decoding<S extends Schema.Constraint> {
  readonly schema: S
  readonly decodeUnknownEffect: (
    input: unknown,
    options?: SchemaAST.ParseOptions
  ) => Effect.Effect<S["Type"], SchemaIssue.Issue, S["DecodingServices"]>
  readonly options?: {
    readonly parseOptions?: SchemaAST.ParseOptions | undefined
  } | undefined
  constructor(schema: S, options?: {
    readonly parseOptions?: SchemaAST.ParseOptions | undefined
  }) {
    this.schema = schema
    this.decodeUnknownEffect = SchemaParser.decodeUnknownEffect(schema)
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
   * **Example** (Testing identity and transformed decoding)
   *
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const decoding = new TestSchema.Asserts(Schema.NumberFromString).decoding()
   * await decoding.succeed("1", 1) // => undefined
   * ```
   *
   * @see {@link fail} for asserting decoding failures
   */
  async succeed<S extends Schema.ConstraintDecoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown
  ): Promise<void>
  async succeed<S extends Schema.ConstraintDecoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    expected: S["Type"]
  ): Promise<void>
  async succeed<S extends Schema.ConstraintDecoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    expected?: S["Type"]
  ) {
    const r = await Effect.runPromise(
      this.decodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager(SchemaIssue.defaultFormatter),
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
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const decoding = new TestSchema.Asserts(Schema.String).decoding()
   * await decoding.fail(42, "Expected string") // => undefined
   * ```
   *
   * @see {@link succeed} for asserting successful decoding
   */
  async fail<S extends Schema.ConstraintDecoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    message: string
  ) {
    const r = await Effect.runPromise(
      this.decodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager(SchemaIssue.defaultFormatter),
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
      pipe(this.schema, Schema.middlewareDecoding(Effect.provideService(service, implementation))),
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
 * ```ts import.meta.vitest
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
 * await encoding.succeed(42, "42") // => undefined
 * ```
 *
 * @see {@link Asserts}
 * @see {@link Decoding}
 *
 * @category testing
 * @since 4.0.0
 */
export class Encoding<S extends Schema.Constraint> {
  readonly schema: S
  readonly encodeUnknownEffect: (
    input: unknown,
    options?: SchemaAST.ParseOptions
  ) => Effect.Effect<S["Encoded"], SchemaIssue.Issue, S["EncodingServices"]>
  readonly options?: {
    readonly parseOptions?: SchemaAST.ParseOptions | undefined
  } | undefined
  constructor(schema: S, options?: {
    readonly parseOptions?: SchemaAST.ParseOptions | undefined
  }) {
    this.schema = schema
    this.encodeUnknownEffect = SchemaParser.encodeUnknownEffect(schema)
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
   * **Example** (Testing identity and transformed encoding)
   *
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
   * await encoding.succeed(1, "1") // => undefined
   * ```
   *
   * @see {@link fail} for asserting encoding failures
   */
  async succeed<S extends Schema.ConstraintEncoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown
  ): Promise<void>
  async succeed<S extends Schema.ConstraintEncoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    expected: S["Encoded"]
  ): Promise<void>
  async succeed<S extends Schema.ConstraintEncoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    expected?: S["Encoded"]
  ) {
    const r = await Effect.runPromise(
      this.encodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager(SchemaIssue.defaultFormatter),
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
   * ```ts import.meta.vitest
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
   * await encoding.fail("not-a-number", "Expected number") // => undefined
   * ```
   *
   * @see {@link succeed} for asserting successful encoding
   */
  async fail<S extends Schema.ConstraintEncoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    message: string
  ) {
    const r = await Effect.runPromise(
      this.encodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapErrorEager(SchemaIssue.defaultFormatter),
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
      pipe(this.schema, Schema.middlewareEncoding(Effect.provideService(service, implementation))),
      this.options
    )
  }
}
