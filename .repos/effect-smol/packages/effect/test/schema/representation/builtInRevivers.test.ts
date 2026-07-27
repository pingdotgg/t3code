import { assert, describe, it } from "@effect/vitest"
import { Formatter, Schema, type SchemaAST, SchemaRepresentation } from "effect"
import { throws } from "../../utils/assert.ts"

function assertFilterReviver<T>(input: {
  readonly schema: Schema.Codec<T>
  readonly id: string
  readonly payload: Schema.Json
  readonly schemas?: ReadonlyArray<SchemaAST.AST>
  readonly reviver: SchemaRepresentation.FilterReviver<any>
  readonly dependencies?: ReadonlyArray<SchemaRepresentation.AnyReviver>
  readonly valid: unknown
  readonly invalid: unknown
  readonly hasToJsonSchema?: boolean
}): void {
  const check = input.schema.ast.checks?.at(-1)
  assert.isDefined(check)
  assert.strictEqual(check._tag, "Filter")
  if (check._tag !== "Filter") return
  assert.deepStrictEqual(check.annotations?.representation, {
    id: input.id,
    payload: input.payload,
    ...(input.schemas === undefined ? undefined : { schemas: input.schemas })
  })

  const document = SchemaRepresentation.toRepresentation(input.schema.ast)
  const json = SchemaRepresentation.toJson(document)
  const revived = SchemaRepresentation.fromRepresentation(SchemaRepresentation.fromJson(json), {
    revivers: [input.reviver, ...(input.dependencies ?? [])]
  }) as Schema.Codec<unknown>

  assert.strictEqual(Schema.decodeUnknownResult(revived)(input.valid)._tag, "Success")
  assert.strictEqual(Schema.decodeUnknownResult(revived)(input.invalid)._tag, "Failure")
  assert.deepStrictEqual(
    SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(revived.ast)),
    json
  )
  const revivedCheck = revived.ast.checks?.at(-1)
  assert.isDefined(revivedCheck)
  assert.strictEqual(revivedCheck._tag, "Filter")
  if (revivedCheck._tag !== "Filter") return
  assert.strictEqual(revivedCheck.annotations?.representation?.id, input.id)
  assert.strictEqual(
    typeof revivedCheck.annotations?.toJsonSchema,
    input.hasToJsonSchema === false ? "undefined" : "function"
  )
  assert.strictEqual(typeof revivedCheck.annotations?.toCode, "function")
}

function assertDeclarationReviver(input: {
  readonly schema: Schema.Top
  readonly id: string
  readonly payload: Schema.Json
  readonly reviver: SchemaRepresentation.DeclarationReviver<any>
  readonly dependencies?: ReadonlyArray<SchemaRepresentation.AnyReviver>
}): void {
  const representation = input.schema.ast.annotations?.representation
  assert.deepStrictEqual(representation, {
    id: input.id,
    payload: input.payload
  })

  const document = SchemaRepresentation.toRepresentation(input.schema.ast)
  const json = SchemaRepresentation.toJson(document)
  const revived = SchemaRepresentation.fromRepresentation(SchemaRepresentation.fromJson(json), {
    revivers: [input.reviver, ...(input.dependencies ?? [])]
  })

  assert.deepStrictEqual(
    SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(revived.ast)),
    json
  )
  assert.strictEqual(
    (revived.ast.annotations?.representation as { readonly id?: string } | undefined)?.id,
    input.id
  )
  assert.strictEqual(typeof revived.ast.annotations?.toCode, "function")
}

describe("SchemaRepresentation built-in string revivers", () => {
  it("revives isStringFinite", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isStringFinite()),
      id: "effect/schema/isStringFinite",
      payload: null,
      reviver: Schema.isStringFiniteReviver,
      valid: "1.5",
      invalid: "Infinity"
    })
  })

  it("revives isStringBigInt", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isStringBigInt()),
      id: "effect/schema/isStringBigInt",
      payload: null,
      reviver: Schema.isStringBigIntReviver,
      valid: "-10",
      invalid: "1.5"
    })
  })

  it("revives isStringSymbol", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isStringSymbol()),
      id: "effect/schema/isStringSymbol",
      payload: null,
      reviver: Schema.isStringSymbolReviver,
      valid: "Symbol(shared)",
      invalid: "shared"
    })
  })

  it("revives isMinLength", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isMinLength(1.8)),
      id: "effect/schema/isMinLength",
      payload: { minLength: 1 },
      reviver: Schema.isMinLengthReviver,
      valid: "a",
      invalid: ""
    })
  })

  it("revives isMaxLength", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isMaxLength(3.8)),
      id: "effect/schema/isMaxLength",
      payload: { maxLength: 3 },
      reviver: Schema.isMaxLengthReviver,
      valid: "abc",
      invalid: "abcd"
    })
  })

  it("revives isLengthBetween", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isLengthBetween(1.8, 3.8)),
      id: "effect/schema/isLengthBetween",
      payload: { minimum: 1, maximum: 3 },
      reviver: Schema.isLengthBetweenReviver,
      valid: "ab",
      invalid: ""
    })
  })

  it("revives isPattern", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isPattern(/^a+$/i)),
      id: "effect/schema/isPattern",
      payload: { source: "^a+$", flags: "i" },
      reviver: Schema.isPatternReviver,
      valid: "AAA",
      invalid: "bbb"
    })
  })

  it("revives isTrimmed", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isTrimmed()),
      id: "effect/schema/isTrimmed",
      payload: null,
      reviver: Schema.isTrimmedReviver,
      valid: "text",
      invalid: " text "
    })
  })

  it("revives isUUID", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isUUID(4)),
      id: "effect/schema/isUUID",
      payload: { version: 4 },
      reviver: Schema.isUUIDReviver,
      valid: "123e4567-e89b-42d3-a456-426614174000",
      invalid: "123e4567-e89b-12d3-a456-426614174000"
    })
  })

  it("revives isGUID", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isGUID()),
      id: "effect/schema/isGUID",
      payload: null,
      reviver: Schema.isGUIDReviver,
      valid: "123e4567-e89b-12d3-a456-426614174000",
      invalid: "not-a-guid"
    })
  })

  it("revives isULID", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isULID()),
      id: "effect/schema/isULID",
      payload: null,
      reviver: Schema.isULIDReviver,
      valid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      invalid: "not-a-ulid"
    })
  })

  it("revives isBase64", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isBase64()),
      id: "effect/schema/isBase64",
      payload: null,
      reviver: Schema.isBase64Reviver,
      valid: "YQ==",
      invalid: "?"
    })
  })

  it("revives isBase64Url", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isBase64Url()),
      id: "effect/schema/isBase64Url",
      payload: null,
      reviver: Schema.isBase64UrlReviver,
      valid: "YQ",
      invalid: "?"
    })
  })

  it("revives isStartsWith", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isStartsWith("pre")),
      id: "effect/schema/isStartsWith",
      payload: { startsWith: "pre" },
      reviver: Schema.isStartsWithReviver,
      valid: "prefix",
      invalid: "suffix"
    })
  })

  it("revives isEndsWith", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isEndsWith("end")),
      id: "effect/schema/isEndsWith",
      payload: { endsWith: "end" },
      reviver: Schema.isEndsWithReviver,
      valid: "weekend",
      invalid: "ending"
    })
  })

  it("revives isIncludes", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isIncludes("mid")),
      id: "effect/schema/isIncludes",
      payload: { includes: "mid" },
      reviver: Schema.isIncludesReviver,
      valid: "middle",
      invalid: "outside"
    })
  })

  it("revives isUppercased", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isUppercased()),
      id: "effect/schema/isUppercased",
      payload: null,
      reviver: Schema.isUppercasedReviver,
      valid: "ABC1",
      invalid: "Abc"
    })
  })

  it("revives isLowercased", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isLowercased()),
      id: "effect/schema/isLowercased",
      payload: null,
      reviver: Schema.isLowercasedReviver,
      valid: "abc1",
      invalid: "Abc"
    })
  })

  it("revives isCapitalized", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isCapitalized()),
      id: "effect/schema/isCapitalized",
      payload: null,
      reviver: Schema.isCapitalizedReviver,
      valid: "Hello",
      invalid: "hello"
    })
  })

  it("revives isUncapitalized", () => {
    assertFilterReviver({
      schema: Schema.String.check(Schema.isUncapitalized()),
      id: "effect/schema/isUncapitalized",
      payload: null,
      reviver: Schema.isUncapitalizedReviver,
      valid: "hello",
      invalid: "Hello"
    })
  })
})

function expectInvalidPayload(json: Schema.Json, reviver: SchemaRepresentation.AnyReviver): void {
  const path = Formatter.formatPath([
    "representation",
    "checks",
    0,
    "representation",
    "payload"
  ])
  throws(
    () => SchemaRepresentation.fromRepresentation(SchemaRepresentation.fromJson(json), { revivers: [reviver] }),
    `Invalid representation payload for ${reviver.id}\n  at ${path}`
  )
}

describe("SchemaRepresentation built-in number revivers", () => {
  it("revives isFinite", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isFinite()),
      id: "effect/schema/isFinite",
      payload: null,
      reviver: Schema.isFiniteReviver,
      valid: 1,
      invalid: Number.POSITIVE_INFINITY
    })
  })

  it("revives isInt", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isInt()),
      id: "effect/schema/isInt",
      payload: null,
      reviver: Schema.isIntReviver,
      valid: 1,
      invalid: 1.5
    })
  })

  it("revives isMultipleOf", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isMultipleOf(3)),
      id: "effect/schema/isMultipleOf",
      payload: { divisor: 3 },
      reviver: Schema.isMultipleOfReviver,
      valid: 6,
      invalid: 7
    })
  })

  it("revives isGreaterThan", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isGreaterThan(1)),
      id: "effect/schema/isGreaterThan",
      payload: { exclusiveMinimum: 1 },
      reviver: Schema.isGreaterThanReviver,
      valid: 2,
      invalid: 1
    })
  })

  it("revives isGreaterThanOrEqualTo", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
      id: "effect/schema/isGreaterThanOrEqualTo",
      payload: { minimum: 1 },
      reviver: Schema.isGreaterThanOrEqualToReviver,
      valid: 1,
      invalid: 0
    })
  })

  it("revives isLessThan", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isLessThan(2)),
      id: "effect/schema/isLessThan",
      payload: { exclusiveMaximum: 2 },
      reviver: Schema.isLessThanReviver,
      valid: 1,
      invalid: 2
    })
  })

  it("revives isLessThanOrEqualTo", () => {
    assertFilterReviver({
      schema: Schema.Number.check(Schema.isLessThanOrEqualTo(2)),
      id: "effect/schema/isLessThanOrEqualTo",
      payload: { maximum: 2 },
      reviver: Schema.isLessThanOrEqualToReviver,
      valid: 2,
      invalid: 3
    })
  })

  it("revives isBetween", () => {
    assertFilterReviver({
      schema: Schema.Number.check(
        Schema.isBetween({ minimum: 1, maximum: 3, exclusiveMinimum: true })
      ),
      id: "effect/schema/isBetween",
      payload: { minimum: 1, maximum: 3, exclusiveMinimum: true },
      reviver: Schema.isBetweenReviver,
      valid: 2,
      invalid: 1
    })
  })

  it("normalizes isBetween flags", () => {
    const check = Schema.isBetween({
      minimum: 1,
      maximum: 3,
      exclusiveMinimum: false,
      exclusiveMaximum: true
    })

    assert.deepStrictEqual(check.annotations?.representation, {
      id: "effect/schema/isBetween",
      payload: { minimum: 1, maximum: 3, exclusiveMaximum: true }
    })
  })

  it("rejects a non-numeric isMultipleOf payload", () => {
    const json = SchemaRepresentation.toJson(
      SchemaRepresentation.toRepresentation(Schema.Number.check(Schema.isMultipleOf(2)).ast)
    ) as any
    json.representation.checks[0].representation.payload.divisor = "2"

    expectInvalidPayload(json, Schema.isMultipleOfReviver)
  })

  it("rejects a non-canonical isBetween payload", () => {
    const json = SchemaRepresentation.toJson(
      SchemaRepresentation.toRepresentation(
        Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3 })).ast
      )
    ) as any
    json.representation.checks[0].representation.payload.exclusiveMinimum = false

    expectInvalidPayload(json, Schema.isBetweenReviver)
  })
})

describe("SchemaRepresentation built-in BigInt revivers", () => {
  it("revives isGreaterThanBigInt", () => {
    assertFilterReviver({
      schema: Schema.BigInt.check(Schema.isGreaterThanBigInt(10n)),
      id: "effect/schema/isGreaterThanBigInt",
      payload: { exclusiveMinimum: "10" },
      reviver: Schema.isGreaterThanBigIntReviver,
      valid: 11n,
      invalid: 10n
    })
  })

  it("revives isGreaterThanOrEqualToBigInt", () => {
    assertFilterReviver({
      schema: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(10n)),
      id: "effect/schema/isGreaterThanOrEqualToBigInt",
      payload: { minimum: "10" },
      reviver: Schema.isGreaterThanOrEqualToBigIntReviver,
      valid: 10n,
      invalid: 9n
    })
  })

  it("revives isLessThanBigInt", () => {
    assertFilterReviver({
      schema: Schema.BigInt.check(Schema.isLessThanBigInt(10n)),
      id: "effect/schema/isLessThanBigInt",
      payload: { exclusiveMaximum: "10" },
      reviver: Schema.isLessThanBigIntReviver,
      valid: 9n,
      invalid: 10n
    })
  })

  it("revives isLessThanOrEqualToBigInt", () => {
    assertFilterReviver({
      schema: Schema.BigInt.check(Schema.isLessThanOrEqualToBigInt(10n)),
      id: "effect/schema/isLessThanOrEqualToBigInt",
      payload: { maximum: "10" },
      reviver: Schema.isLessThanOrEqualToBigIntReviver,
      valid: 10n,
      invalid: 11n
    })
  })

  it("revives isBetweenBigInt", () => {
    assertFilterReviver({
      schema: Schema.BigInt.check(
        Schema.isBetweenBigInt({ minimum: -10n, maximum: 10n, exclusiveMaximum: true })
      ),
      id: "effect/schema/isBetweenBigInt",
      payload: { minimum: "-10", maximum: "10", exclusiveMaximum: true },
      reviver: Schema.isBetweenBigIntReviver,
      valid: 0n,
      invalid: 10n
    })
  })

  it("persists large bounds as canonical decimal strings", () => {
    const value = 900719925474099312345678901234567890n
    assert.deepStrictEqual(Schema.isGreaterThanBigInt(value).annotations?.representation, {
      id: "effect/schema/isGreaterThanBigInt",
      payload: { exclusiveMinimum: "900719925474099312345678901234567890" }
    })
  })

  it("normalizes isBetweenBigInt flags", () => {
    assert.deepStrictEqual(
      Schema.isBetweenBigInt({
        minimum: -1n,
        maximum: 1n,
        exclusiveMinimum: false,
        exclusiveMaximum: true
      }).annotations?.representation,
      {
        id: "effect/schema/isBetweenBigInt",
        payload: { minimum: "-1", maximum: "1", exclusiveMaximum: true }
      }
    )
  })
})

function date(millis: number): Date {
  return new globalThis.Date(millis)
}

const epoch = "1970-01-01T00:00:00.000Z"

describe("SchemaRepresentation built-in Date revivers", () => {
  it("revives isGreaterThanDate", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isGreaterThanDate(date(0))),
      id: "effect/schema/isGreaterThanDate",
      payload: { exclusiveMinimum: epoch },
      reviver: Schema.isGreaterThanDateReviver,
      valid: date(1),
      invalid: date(0)
    })
  })

  it("revives isGreaterThanOrEqualToDate", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isGreaterThanOrEqualToDate(date(0))),
      id: "effect/schema/isGreaterThanOrEqualToDate",
      payload: { minimum: epoch },
      reviver: Schema.isGreaterThanOrEqualToDateReviver,
      valid: date(0),
      invalid: date(-1)
    })
  })

  it("revives isLessThanDate", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isLessThanDate(date(0))),
      id: "effect/schema/isLessThanDate",
      payload: { exclusiveMaximum: epoch },
      reviver: Schema.isLessThanDateReviver,
      valid: date(-1),
      invalid: date(0)
    })
  })

  it("revives isLessThanOrEqualToDate", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isLessThanOrEqualToDate(date(0))),
      id: "effect/schema/isLessThanOrEqualToDate",
      payload: { maximum: epoch },
      reviver: Schema.isLessThanOrEqualToDateReviver,
      valid: date(0),
      invalid: date(1)
    })
  })

  it("revives isBetweenDate", () => {
    assertFilterReviver({
      schema: Schema.Any.check(
        Schema.isBetweenDate({ minimum: date(0), maximum: date(2), exclusiveMaximum: true })
      ),
      id: "effect/schema/isBetweenDate",
      payload: {
        minimum: epoch,
        maximum: "1970-01-01T00:00:00.002Z",
        exclusiveMaximum: true
      },
      reviver: Schema.isBetweenDateReviver,
      valid: date(1),
      invalid: date(2)
    })
  })

  it("persists millisecond precision", () => {
    assert.deepStrictEqual(Schema.isGreaterThanDate(date(123)).annotations?.representation, {
      id: "effect/schema/isGreaterThanDate",
      payload: { exclusiveMinimum: "1970-01-01T00:00:00.123Z" }
    })
  })

  it("normalizes isBetweenDate flags", () => {
    assert.deepStrictEqual(
      Schema.isBetweenDate({
        minimum: date(-1),
        maximum: date(1),
        exclusiveMinimum: false,
        exclusiveMaximum: true
      }).annotations?.representation,
      {
        id: "effect/schema/isBetweenDate",
        payload: {
          minimum: "1969-12-31T23:59:59.999Z",
          maximum: "1970-01-01T00:00:00.001Z",
          exclusiveMaximum: true
        }
      }
    )
  })
})

describe("SchemaRepresentation built-in collection revivers", () => {
  it("revives isMinSize", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isMinSize(2)),
      id: "effect/schema/isMinSize",
      payload: { minSize: 2 },
      reviver: Schema.isMinSizeReviver,
      valid: new Set([1, 2]),
      invalid: new Set([1])
    })
  })

  it("revives isMaxSize", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isMaxSize(1)),
      id: "effect/schema/isMaxSize",
      payload: { maxSize: 1 },
      reviver: Schema.isMaxSizeReviver,
      valid: new Set([1]),
      invalid: new Set([1, 2])
    })
  })

  it("revives isSizeBetween", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isSizeBetween(1, 2)),
      id: "effect/schema/isSizeBetween",
      payload: { minimum: 1, maximum: 2 },
      reviver: Schema.isSizeBetweenReviver,
      valid: new Set([1]),
      invalid: new Set()
    })
  })

  it("revives isUnique", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isUnique()),
      id: "effect/schema/isUnique",
      payload: null,
      reviver: Schema.isUniqueReviver,
      valid: [1, 2],
      invalid: [1, 1]
    })
  })

  it("normalizes isMinSize", () => {
    assert.deepStrictEqual(Schema.isMinSize(-1).annotations?.representation, {
      id: "effect/schema/isMinSize",
      payload: { minSize: 0 }
    })
  })

  it("normalizes isMaxSize", () => {
    assert.deepStrictEqual(Schema.isMaxSize(2.9).annotations?.representation, {
      id: "effect/schema/isMaxSize",
      payload: { maxSize: 2 }
    })
  })

  it("normalizes isSizeBetween", () => {
    assert.deepStrictEqual(Schema.isSizeBetween(1.9, 3.7).annotations?.representation, {
      id: "effect/schema/isSizeBetween",
      payload: { minimum: 1, maximum: 3 }
    })
  })
})

describe("SchemaRepresentation built-in object revivers", () => {
  it("revives isMinProperties", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isMinProperties(2)),
      id: "effect/schema/isMinProperties",
      payload: { minProperties: 2 },
      reviver: Schema.isMinPropertiesReviver,
      valid: { a: 1, b: 2 },
      invalid: { a: 1 }
    })
  })

  it("revives isMaxProperties", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isMaxProperties(1)),
      id: "effect/schema/isMaxProperties",
      payload: { maxProperties: 1 },
      reviver: Schema.isMaxPropertiesReviver,
      valid: { a: 1 },
      invalid: { a: 1, b: 2 }
    })
  })

  it("revives isPropertiesLengthBetween", () => {
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isPropertiesLengthBetween(1, 2)),
      id: "effect/schema/isPropertiesLengthBetween",
      payload: { minimum: 1, maximum: 2 },
      reviver: Schema.isPropertiesLengthBetweenReviver,
      valid: { a: 1 },
      invalid: {}
    })
  })

  it("revives isPropertyNames", () => {
    const names = Schema.String.check(Schema.isPattern(/^[A-Z]/))
    assertFilterReviver({
      schema: Schema.Any.check(Schema.isPropertyNames(names)),
      id: "effect/schema/isPropertyNames",
      payload: null,
      schemas: [names.ast],
      reviver: Schema.isPropertyNamesReviver,
      dependencies: [Schema.isPatternReviver],
      valid: { Alpha: 1 },
      invalid: { alpha: 1 }
    })
  })

  it("persists the encoded key schema for isPropertyNames", () => {
    const names = Schema.String.check(Schema.isPattern(/^[A-Z]/))
    const check = Schema.isPropertyNames(names)

    assert.deepStrictEqual(check.annotations?.representation, {
      id: "effect/schema/isPropertyNames",
      payload: null,
      schemas: [names.ast]
    })
  })

  it("normalizes isMinProperties", () => {
    assert.deepStrictEqual(Schema.isMinProperties(-1).annotations?.representation, {
      id: "effect/schema/isMinProperties",
      payload: { minProperties: 0 }
    })
  })

  it("normalizes isMaxProperties", () => {
    assert.deepStrictEqual(Schema.isMaxProperties(2.9).annotations?.representation, {
      id: "effect/schema/isMaxProperties",
      payload: { maxProperties: 2 }
    })
  })

  it("normalizes isPropertiesLengthBetween", () => {
    assert.deepStrictEqual(Schema.isPropertiesLengthBetween(1.9, 3.7).annotations?.representation, {
      id: "effect/schema/isPropertiesLengthBetween",
      payload: { minimum: 1, maximum: 3 }
    })
  })
})

describe("SchemaRepresentation built-in declaration revivers", () => {
  it("revives Option", () => {
    assertDeclarationReviver({
      schema: Schema.Option(Schema.String),
      id: "effect/schema/Option",
      payload: null,
      reviver: Schema.OptionReviver
    })
  })

  it("revives Result", () => {
    assertDeclarationReviver({
      schema: Schema.Result(Schema.String, Schema.Number),
      id: "effect/schema/Result",
      payload: null,
      reviver: Schema.ResultReviver
    })
  })

  it("revives Redacted", () => {
    assertDeclarationReviver({
      schema: Schema.Redacted(Schema.String),
      id: "effect/schema/Redacted",
      payload: null,
      reviver: Schema.RedactedReviver
    })
  })

  it("revives CauseReason", () => {
    assertDeclarationReviver({
      schema: Schema.CauseReason(Schema.String, Schema.Number),
      id: "effect/schema/CauseReason",
      payload: null,
      reviver: Schema.CauseReasonReviver
    })
  })

  it("revives Cause", () => {
    assertDeclarationReviver({
      schema: Schema.Cause(Schema.String, Schema.Number),
      id: "effect/schema/Cause",
      payload: null,
      reviver: Schema.CauseReviver
    })
  })

  it("revives Error", () => {
    assertDeclarationReviver({
      schema: Schema.Error(),
      id: "effect/schema/Error",
      payload: null,
      reviver: Schema.ErrorReviver
    })
  })

  it("revives Exit", () => {
    assertDeclarationReviver({
      schema: Schema.Exit(Schema.String, Schema.Number, Schema.Boolean),
      id: "effect/schema/Exit",
      payload: null,
      reviver: Schema.ExitReviver
    })
  })

  it("revives ReadonlyMap", () => {
    assertDeclarationReviver({
      schema: Schema.ReadonlyMap(Schema.String, Schema.Number),
      id: "effect/schema/ReadonlyMap",
      payload: null,
      reviver: Schema.ReadonlyMapReviver
    })
  })

  it("revives HashMap", () => {
    assertDeclarationReviver({
      schema: Schema.HashMap(Schema.String, Schema.Number),
      id: "effect/schema/HashMap",
      payload: null,
      reviver: Schema.HashMapReviver
    })
  })

  it("revives ReadonlySet", () => {
    assertDeclarationReviver({
      schema: Schema.ReadonlySet(Schema.String),
      id: "effect/schema/ReadonlySet",
      payload: null,
      reviver: Schema.ReadonlySetReviver
    })
  })

  it("revives HashSet", () => {
    assertDeclarationReviver({
      schema: Schema.HashSet(Schema.String),
      id: "effect/schema/HashSet",
      payload: null,
      reviver: Schema.HashSetReviver
    })
  })

  it("revives Chunk", () => {
    assertDeclarationReviver({
      schema: Schema.Chunk(Schema.String),
      id: "effect/schema/Chunk",
      payload: null,
      reviver: Schema.ChunkReviver
    })
  })

  it("revives RegExp", () => {
    assertDeclarationReviver({
      schema: Schema.RegExp,
      id: "effect/schema/RegExp",
      payload: null,
      reviver: Schema.RegExpReviver
    })
  })

  it("revives URL", () => {
    assertDeclarationReviver({
      schema: Schema.URL,
      id: "effect/schema/URL",
      payload: null,
      reviver: Schema.URLReviver
    })
  })

  it("revives Date", () => {
    assertDeclarationReviver({
      schema: Schema.Date,
      id: "effect/schema/Date",
      payload: null,
      reviver: Schema.DateReviver
    })
  })

  it("revives Duration", () => {
    assertDeclarationReviver({
      schema: Schema.Duration,
      id: "effect/schema/Duration",
      payload: null,
      reviver: Schema.DurationReviver
    })
  })

  it("revives BigDecimal", () => {
    assertDeclarationReviver({
      schema: Schema.BigDecimal,
      id: "effect/schema/BigDecimal",
      payload: null,
      reviver: Schema.BigDecimalReviver
    })
  })

  it("revives File", () => {
    assertDeclarationReviver({
      schema: Schema.File,
      id: "effect/schema/File",
      payload: null,
      reviver: Schema.FileReviver
    })
  })

  it("revives FormData", () => {
    assertDeclarationReviver({
      schema: Schema.FormData,
      id: "effect/schema/FormData",
      payload: null,
      reviver: Schema.FormDataReviver
    })
  })

  it("revives URLSearchParams", () => {
    assertDeclarationReviver({
      schema: Schema.URLSearchParams,
      id: "effect/schema/URLSearchParams",
      payload: null,
      reviver: Schema.URLSearchParamsReviver
    })
  })

  it("revives Uint8Array", () => {
    assertDeclarationReviver({
      schema: Schema.Uint8Array,
      id: "effect/schema/Uint8Array",
      payload: null,
      reviver: Schema.Uint8ArrayReviver
    })
  })

  it("revives DateTimeUtc", () => {
    assertDeclarationReviver({
      schema: Schema.DateTimeUtc,
      id: "effect/schema/DateTimeUtc",
      payload: null,
      reviver: Schema.DateTimeUtcReviver
    })
  })

  it("revives TimeZoneOffset", () => {
    assertDeclarationReviver({
      schema: Schema.TimeZoneOffset,
      id: "effect/schema/TimeZoneOffset",
      payload: null,
      reviver: Schema.TimeZoneOffsetReviver
    })
  })

  it("revives TimeZoneNamed", () => {
    assertDeclarationReviver({
      schema: Schema.TimeZoneNamed,
      id: "effect/schema/TimeZoneNamed",
      payload: null,
      reviver: Schema.TimeZoneNamedReviver
    })
  })

  it("revives TimeZone", () => {
    assertDeclarationReviver({
      schema: Schema.TimeZone,
      id: "effect/schema/TimeZone",
      payload: null,
      reviver: Schema.TimeZoneReviver
    })
  })

  it("revives DateTimeZoned", () => {
    assertDeclarationReviver({
      schema: Schema.DateTimeZoned,
      id: "effect/schema/DateTimeZoned",
      payload: null,
      reviver: Schema.DateTimeZonedReviver
    })
  })

  it("revives Json", () => {
    assertDeclarationReviver({
      schema: Schema.Json,
      id: "effect/schema/Json",
      payload: null,
      reviver: Schema.JsonReviver
    })
  })

  it("revives MutableJson", () => {
    assertDeclarationReviver({
      schema: Schema.MutableJson,
      id: "effect/schema/MutableJson",
      payload: null,
      reviver: Schema.MutableJsonReviver
    })
  })

  it("persists Error includeStack", () => {
    assert.deepStrictEqual(Schema.Error({ includeStack: true }).ast.annotations?.representation, {
      id: "effect/schema/Error",
      payload: { includeStack: true }
    })
  })

  it("persists Error excludeCause", () => {
    assert.deepStrictEqual(Schema.Error({ excludeCause: true }).ast.annotations?.representation, {
      id: "effect/schema/Error",
      payload: { excludeCause: true }
    })
  })

  it("omits disabled Error options", () => {
    assert.deepStrictEqual(
      Schema.Error({ includeStack: false, excludeCause: false }).ast.annotations?.representation,
      { id: "effect/schema/Error", payload: null }
    )
  })

  it("persists a Redacted label", () => {
    assert.deepStrictEqual(
      Schema.Redacted(Schema.String, { label: "password" }).ast.annotations?.representation,
      { id: "effect/schema/Redacted", payload: { label: "password" } }
    )
  })

  it("persists Redacted disallowJsonEncode", () => {
    assert.deepStrictEqual(
      Schema.Redacted(Schema.String, { disallowJsonEncode: true }).ast.annotations?.representation,
      { id: "effect/schema/Redacted", payload: { disallowJsonEncode: true } }
    )
  })

  it("omits disabled Redacted options", () => {
    assert.deepStrictEqual(
      Schema.Redacted(Schema.String, {
        label: undefined,
        disallowJsonEncode: false
      }).ast.annotations?.representation,
      { id: "effect/schema/Redacted", payload: null }
    )
  })
})
