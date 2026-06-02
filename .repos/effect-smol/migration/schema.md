# Schema: Migration from v3

This document maps v3 Schema APIs to their v4 equivalents. Simple renames and argument changes are covered in the summary table below. More complex migrations have dedicated sections with code examples.

## Migration types

- **auto** — mechanical find-and-replace, safe to auto-apply
- **semi-auto** — follows a clear pattern but needs structural changes
- **manual** — requires case-by-case decisions, flag for human review
- **removed** — no v4 equivalent

## Summary table

| v3 API                                          | v4 API                                                                        | Migration type    |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | ----------------- |
| `asSchema(schema)`                              | `revealCodec(schema)`                                                         | rename            |
| `encodedSchema(schema)`                         | `toEncoded(schema)`                                                           | rename            |
| `typeSchema(schema)`                            | `toType(schema)`                                                              | rename            |
| `compose(schemaB)`                              | `decodeTo(schemaB)`                                                           | rename            |
| `annotations(ann)`                              | `annotate(ann)`                                                               | rename            |
| `decodingFallback` annotation                   | `catchDecoding(...)`                                                          | rename            |
| `parseJson()`                                   | `UnknownFromJsonString`                                                       | rename            |
| `parseJson(schema)`                             | `fromJsonString(schema)`                                                      | rename            |
| `pattern(regex)`                                | `check(isPattern(regex))`                                                     | rename            |
| `nonEmptyString`                                | `isNonEmpty`                                                                  | rename            |
| `BigIntFromSelf`                                | `BigInt`                                                                      | rename            |
| `SymbolFromSelf`                                | `Symbol`                                                                      | rename            |
| `URLFromSelf`                                   | `URL`                                                                         | rename            |
| `RedactedFromSelf`                              | `Redacted`                                                                    | rename            |
| `Redacted`                                      | `RedactedFromValue`                                                           | rename            |
| `EitherFromSelf`                                | `Result`                                                                      | rename            |
| `TaggedError`                                   | `TaggedErrorClass`                                                            | rename            |
| `decodeUnknown`                                 | `decodeUnknownEffect`                                                         | rename            |
| `decode`                                        | `decodeEffect`                                                                | rename            |
| `decodeUnknownEither`                           | `decodeUnknownExit`                                                           | rename            |
| `decodeEither`                                  | `decodeExit`                                                                  | rename            |
| `encodeUnknown`                                 | `encodeUnknownEffect`                                                         | rename            |
| `encode`                                        | `encodeEffect`                                                                | rename            |
| `encodeUnknownEither`                           | `encodeUnknownExit`                                                           | rename            |
| `encodeEither`                                  | `encodeExit`                                                                  | rename            |
| `asserts(schema)(input)`                        | `asserts(schema, input)`                                                      | semi-auto         |
| `Literal(null)`                                 | `Null`                                                                        | restructure       |
| `Literal("a", "b")`                             | `Literals(["a", "b"])`                                                        | variadic-to-array |
| `pickLiteral("a", "b")`                         | `Literals(...).pick(["a", "b"])`                                              | restructure       |
| `Union(A, B)`                                   | `Union([A, B])`                                                               | variadic-to-array |
| `Tuple(A, B)`                                   | `Tuple([A, B])`                                                               | variadic-to-array |
| `TemplateLiteral(A, B)`                         | `TemplateLiteral([A, B])`                                                     | variadic-to-array |
| `TemplateLiteralParser(A, B)`                   | `TemplateLiteralParser(schema.parts)`                                         | restructure       |
| `Record({ key, value })`                        | `Record(key, value)`                                                          | restructure       |
| `filter(predicate)`                             | `check(makeFilter(predicate))`                                                | restructure       |
| `filter(refinement)`                            | `refine(refinement)`                                                          | restructure       |
| `UUID`                                          | `String.check(isUUID())`                                                      | restructure       |
| `ULID`                                          | `String.check(isULID())`                                                      | restructure       |
| `pick("a")`                                     | `mapFields(Struct.pick(["a"]))`                                               | restructure       |
| `omit("a")`                                     | `mapFields(Struct.omit(["a"]))`                                               | restructure       |
| `partial`                                       | `mapFields(Struct.map(Schema.optional))`                                      | restructure       |
| `partialWith({ exact: true })`                  | `mapFields(Struct.map(Schema.optionalKey))`                                   | restructure       |
| `required(schema)`                              | `schema.mapFields(Struct.map(Schema.requiredKey))`                            | restructure       |
| `extend(structB)`                               | `mapFields(Struct.assign(fieldsB))` or `fieldsAssign(fieldsB)`                | restructure       |
| `transform(from, to, { decode, encode })`       | `from.pipe(decodeTo(to, SchemaTransformation.transform({ decode, encode })))` | restructure       |
| `transformOrFail(from, to, { decode, encode })` | `from.pipe(decodeTo(to, { decode: SchemaGetter.transformOrFail(...), ... }))` | restructure       |
| `transformLiteral(from, to)`                    | `Literal(from).transform(to)`                                                 | restructure       |
| `transformLiterals([0,"a"], [1,"b"])`           | `Literals([0, 1]).transform(["a", "b"])`                                      | restructure       |
| `attachPropertySignature("k", "v")`             | `mapFields(f => ({...f, k: tagDefaultOmit("v")}))`                            | restructure       |
| `validate*`                                     | removed (use `decode*` + `toType`)                                            | removed           |
| `keyof`                                         | —                                                                             | removed           |
| `NonEmptyArrayEnsure`                           | —                                                                             | removed           |
| `withDefaults`                                  | —                                                                             | removed           |
| `Data(schema)`                                  | —                                                                             | removed           |
| `optionalWith(schema, opts)`                    | varies by options (see [optionalWith](#optionalwith))                         | manual            |
| `optionalToOptional`                            | see [optional field transformations](#optional-field-transformations)         | manual            |
| `optionalToRequired`                            | see [optional field transformations](#optional-field-transformations)         | manual            |
| `requiredToOptional`                            | see [optional field transformations](#optional-field-transformations)         | manual            |
| `filterEffect`                                  | see [filterEffect](#filtereffect)                                             | manual            |
| `fromKey`                                       | see [rename](#rename)                                                         | manual            |
| `rename({ a: "c" })`                            | see [rename](#rename)                                                         | manual            |
| `format(schema)`                                | see [format](#format)                                                         | manual            |
| `ParseResult.ArrayFormatter.formatError(error)` | see [ParseResult formatters](#parseresult-formatters)                         | manual            |
| `declare`                                       | see [declare](#declare)                                                       | manual            |

## Additional rename notes

### `*FromSelf` renames

The following `*FromSelf` schemas have been renamed to drop the suffix:

`DateFromSelf` → `Date`, `DurationFromSelf` → `Duration`, `ChunkFromSelf` → `Chunk`, `ReadonlyMapFromSelf` → `ReadonlyMap`, `ReadonlySetFromSelf` → `ReadonlySet`, `HashMapFromSelf` → `HashMap`, `HashSetFromSelf` → `HashSet`, `BigDecimalFromSelf` → `BigDecimal`, `CauseFromSelf` → `Cause`, `ExitFromSelf` → `Exit`, `OptionFromSelf` → `Option`, `RegExpFromSelf` → `RegExp`

### Filter renames

All filters have been renamed with an `is` prefix and now use `check(...)` or `pipe(Schema.check(...))`:

`greaterThan` → `isGreaterThan`, `greaterThanOrEqualTo` → `isGreaterThanOrEqualTo`, `lessThan` → `isLessThan`, `lessThanOrEqualTo` → `isLessThanOrEqualTo`, `between` → `isBetween`, `int` → `isInt`, `multipleOf` → `isMultipleOf`, `finite` → `isFinite`, `minLength` → `isMinLength`, `maxLength` → `isMaxLength`, `length` → `isLengthBetween`

Note: `positive`, `negative`, `nonNegative`, `nonPositive` have been removed in v4.

### Utility renames

`equivalence` → `toEquivalence`, `arbitrary` → `toArbitrary`, `pretty` → `toFormatter`, `standardSchemaV1` → `toStandardSchemaV1`

## Detailed migrations

### asserts signature

**Migration: semi-auto**

`Schema.asserts` now asserts an input directly instead of returning an assertion function.

v3

```ts
import { Schema } from "effect"

const assertString = Schema.asserts(Schema.String)
assertString(input)
```

v4

```ts
import { Schema } from "effect"

Schema.asserts(Schema.String, input)
```

### validate* removal

**Migration: removed**

The `validate`, `validateEither`, `validatePromise`, `validateSync`, and `validateOption` APIs have been removed. Use `Schema.decode*` + `Schema.toType` instead.

```ts
import { Schema } from "effect"

// v3: Schema.validateSync(Schema.String)(input)
// v4:
const validateSync = Schema.decodeSync(Schema.toType(Schema.String))
```

### Data removal

**Migration: removed**

`Schema.Data` has no v4 equivalent. Remove it. `Equal.equals` performs deep structural comparison on objects by default in v4, so `Schema.Data` is unnecessary.

### pickLiterals

**Migration: auto**

v3

```ts
import { Schema } from "effect"

const schema = Schema.Literal("a", "b", "c").pipe(Schema.pickLiteral("a", "b"))
```

v4

```ts
import { Schema } from "effect"

const schema = Schema.Literals(["a", "b", "c"]).pick(["a", "b"])
```

### TemplateLiteralParser

**Migration: semi-auto**

v3

```ts
import { Schema } from "effect"

const schema = Schema.TemplateLiteral(Schema.String, ".", Schema.String)
const parser = Schema.TemplateLiteralParser(Schema.String, ".", Schema.String)
```

v4

```ts
import { Schema } from "effect"

const schema = Schema.TemplateLiteral([Schema.String, ".", Schema.String])
// use the `parts` property instead of repeating the template parts
const parser = Schema.TemplateLiteralParser(schema.parts)
```

### format

**Migration: manual**

**New imports:** `SchemaRepresentation`

v3

```ts
import { Schema } from "effect"

console.log(Schema.format(Schema.String))
// string
```

v4

```ts
import { Schema, SchemaRepresentation } from "effect"

const doc = SchemaRepresentation.fromAST(Schema.String.ast)
const multi = SchemaRepresentation.toMultiDocument(doc)
const codeDoc = SchemaRepresentation.toCodeDocument(multi)
console.log(codeDoc.codes[0].Type)
// string
```

### ParseResult formatters

**Migration: manual**

**New imports:** `SchemaIssue`

In v4, schema parsing fails with `Schema.SchemaError`, which contains a nested `SchemaIssue` in its `issue` field.

Use `SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues` for the v3 `ParseResult.ArrayFormatter.formatError(error)` equivalent.

v3

```ts
import { Either, ParseResult, Schema } from "effect"

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number
})

const decode = Schema.decodeUnknownEither(Person)

const result = decode({})
if (Either.isLeft(result)) {
  console.error("Decoding failed:")
  console.error(ParseResult.ArrayFormatter.formatErrorSync(result.left))
}
/*
Decoding failed:
[ { _tag: 'Missing', path: [ 'name' ], message: 'is missing' } ]
*/
```

v4

```ts
import { Schema, SchemaIssue } from "effect"

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number
})

const decode = Schema.decodeUnknownSync(Person)

try {
  decode({})
} catch (error) {
  if (error instanceof Error) {
    console.error("Decoding failed:")
    if (SchemaIssue.isIssue(error.cause)) {
      console.error(SchemaIssue.makeFormatterStandardSchemaV1()(error.cause).issues)
    }
  }
}
/*
Decoding failed:
[ { path: [ 'name' ], message: 'Missing key' } ]
*/
```

### Record

**Migration: auto**

v3

```ts
import { Schema } from "effect"

const schema = Schema.Record({ key: Schema.String, value: Schema.Number })
```

v4

```ts
import { Schema } from "effect"

const schema = Schema.Record(Schema.String, Schema.Number)
```

### pick / omit

**Migration: semi-auto**

**New imports:** `Struct`

v3

```ts
import { Schema } from "effect"

const picked = Schema.Struct({ a: Schema.String, b: Schema.Number }).pipe(Schema.pick("a"))
const omitted = Schema.Struct({ a: Schema.String, b: Schema.Number }).pipe(Schema.omit("b"))
```

v4

```ts
import { Schema, Struct } from "effect"

const picked = Schema.Struct({ a: Schema.String, b: Schema.Number }).mapFields(Struct.pick(["a"]))
const omitted = Schema.Struct({ a: Schema.String, b: Schema.Number }).mapFields(Struct.omit(["b"]))
```

### partial / partialWith

**Migration: semi-auto**

**New imports:** `Struct`

- `Schema.partial` → `mapFields(Struct.map(Schema.optional))` (allows `undefined`)
- `Schema.partialWith({ exact: true })` → `mapFields(Struct.map(Schema.optionalKey))` (exact)

```ts
import { Schema, Struct } from "effect"

const struct = Schema.Struct({ a: Schema.String, b: Schema.Number })

// v3: struct.pipe(Schema.partial)
const withUndefined = struct.mapFields(Struct.map(Schema.optional))

// v3: struct.pipe(Schema.partialWith({ exact: true }))
const exact = struct.mapFields(Struct.map(Schema.optionalKey))
```

You can also make a subset of fields partial:

```ts
import { Schema, Struct } from "effect"

const schema = Schema.Struct({ a: Schema.String, b: Schema.Number })
  .mapFields(Struct.mapPick(["a"], Schema.optional))
```

### required

**Migration: semi-auto**

**New imports:** `Struct`

- `Schema.requiredKey`: makes `optionalKey` fields required; makes `optional` fields required as `T | undefined`
- `Schema.required`: makes `optional` fields required (removes `undefined`)

```ts
import { Schema, Struct } from "effect"

const original = Schema.Struct({
  a: Schema.optionalKey(Schema.String),
  b: Schema.optionalKey(Schema.Number)
})

// v3: Schema.required(original)
const schema = original.mapFields(Struct.map(Schema.requiredKey))
// { readonly a: string; readonly b: number; }
```

### optional field transformations

**Migration: manual**

**New imports:** `SchemaGetter`

`optionalToOptional`, `optionalToRequired`, and `requiredToOptional` are all replaced by `Schema.decodeTo` + `SchemaGetter.transformOptional`.

The pattern: start with the encoded optionality (`optionalKey` or required), pipe to `decodeTo` with the decoded optionality, and provide `transformOptional` functions for decode/encode.

**Example** (v3 `optionalToRequired`: setting `null` as default for missing field)

v3

```ts
import { Option, Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalToRequired(Schema.String, Schema.NullOr(Schema.String), {
    decode: Option.getOrElse(() => null),
    encode: Option.liftPredicate((value) => value !== null)
  })
})
```

v4

```ts
import { Option, Schema, SchemaGetter } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalKey(Schema.String).pipe(
    Schema.decodeTo(Schema.NullOr(Schema.String), {
      decode: SchemaGetter.transformOptional(Option.orElseSome(() => null)),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== null))
    })
  )
})
```

**Example** (v3 `requiredToOptional`: empty string as missing value)

v3

```ts
import { Option, Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.requiredToOptional(Schema.String, Schema.String, {
    decode: Option.liftPredicate((s) => s !== ""),
    encode: Option.getOrElse(() => "")
  })
})
```

v4

```ts
import { Option, Schema, SchemaGetter } from "effect"

const schema = Schema.Struct({
  a: Schema.String.pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.String), {
      decode: SchemaGetter.transformOptional(Option.filter((value) => value !== "")),
      encode: SchemaGetter.transformOptional(Option.orElseSome(() => ""))
    })
  )
})
```

### optionalWith

**Migration: manual**

**New imports:** `SchemaGetter`, `Predicate` (for nullable variants)

#### Decision tree

| v3 options                                 | v4 pattern                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `{ exact: true }`                          | `optionalKey(schema)`                                                   |
| `{ default }`                              | `schema.pipe(withDecodingDefaultType(...))`                             |
| `{ exact: true, default }`                 | `schema.pipe(withDecodingDefaultTypeKey(...))`                          |
| `{ nullable: true }`                       | `optional(NullOr(schema))` + `decodeTo` + filter null                   |
| `{ nullable: true, exact: true }`          | `optionalKey(NullOr(schema))` + `decodeTo` + filter null                |
| `{ nullable: true, default }`              | `optional(NullOr(schema))` + `decodeTo` + filter null + `orElseSome`    |
| `{ nullable: true, exact: true, default }` | `optionalKey(NullOr(schema))` + `decodeTo` + filter null + `orElseSome` |

Key rules:

- `exact: true` → use `optionalKey` instead of `optional`
- `nullable: true` → wrap inner schema in `NullOr` and filter nulls via `Option.filter(Predicate.isNotNull)`
- `default` → use `withDecodingDefaultType` (or `withDecodingDefaultTypeKey` with `exact: true`)

#### Example: `{ exact: true }` (simplest case)

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalWith(Schema.NumberFromString, { exact: true })
})
```

v4

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalKey(Schema.NumberFromString)
})
```

#### Example: `{ default }`

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalWith(Schema.String, { default: () => "" })
})
```

v4

```ts
import { Effect, Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed("")))
})
```

#### Example: `{ exact: true, default }`

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalWith(Schema.String, { exact: true, default: () => "" })
})
```

v4

```ts
import { Effect, Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("")))
})
```

#### Example: `{ nullable: true, exact: true, default }` (most complex case)

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalWith(Schema.NumberFromString, { nullable: true, default: () => -1, exact: true })
})
```

v4

```ts
import { Option, Predicate, Schema, SchemaGetter } from "effect"

const schema = Schema.Struct({
  a: Schema.optionalKey(Schema.NullOr(Schema.NumberFromString)).pipe(
    Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.transformOptional((o) =>
        o.pipe(Option.filter(Predicate.isNotNull), Option.orElseSome(() => -1))
      ),
      encode: SchemaGetter.required()
    })
  )
})
```

### pluck

**Migration: manual**

**New imports:** `SchemaGetter`, `Struct`

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({ a: Schema.String, b: Schema.Number }).pipe(Schema.pluck("a"))
```

v4

```ts
import { Schema, SchemaGetter, Struct } from "effect"

function pluck<P extends PropertyKey>(key: P) {
  return <S extends Schema.Top>(
    schema: Schema.Struct<{ [K in P]: S }>
  ): Schema.decodeTo<Schema.toType<S>, Schema.Struct<{ [K in P]: S }>> => {
    return schema.mapFields(Struct.pick([key])).pipe(
      Schema.decodeTo(Schema.toType(schema.fields[key]), {
        decode: SchemaGetter.transform((whole: any) => whole[key]),
        encode: SchemaGetter.transform((value) => ({ [key]: value } as any))
      })
    )
  }
}

const schema = Schema.Struct({ a: Schema.String, b: Schema.Number }).pipe(pluck("a"))
```

### extend

**Migration: semi-auto**

**New imports:** `Struct` (Struct case), `Tuple` (Union case)

#### Struct extends Struct

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.Number
}).pipe(Schema.extend(Schema.Struct({ c: Schema.Number })))
```

v4

```ts
import { Schema, Struct } from "effect"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.Number
}).mapFields(Struct.assign({ c: Schema.Number }))

// or more succinctly
const schema2 = Schema.Struct({
  a: Schema.String,
  b: Schema.Number
}).pipe(Schema.fieldsAssign({ c: Schema.Number }))
```

#### Union extends Struct

v3

```ts
import { Schema } from "effect"

const schema = Schema.Union(
  Schema.Struct({ a: Schema.String }),
  Schema.Struct({ b: Schema.Number })
).pipe(Schema.extend(Schema.Struct({ c: Schema.Boolean })))
```

v4

```ts
import { Schema, Tuple } from "effect"

const schema = Schema.Union([
  Schema.Struct({ a: Schema.String }),
  Schema.Struct({ b: Schema.Number })
]).mapMembers(Tuple.map(Schema.fieldsAssign({ c: Schema.Number })))
```

### filter

**Migration: semi-auto**

v3

```ts
import { Schema } from "effect"

// inline filter
const a = Schema.String.pipe(Schema.filter((s) => s.length > 0))

// refinement
const b = Schema.Option(Schema.String).pipe(Schema.filter(Option.isSome))
```

v4

```ts
import { Option, Schema } from "effect"

// inline filter
const a = Schema.String.check(Schema.makeFilter((s) => s.length > 0))

// refinement
const b = Schema.Option(Schema.String).pipe(Schema.refine(Option.isSome))
```

In v4, a `makeFilter` predicate can return any of the shapes described by `Schema.FilterOutput`:

- `undefined` / `true` — success
- `false` — generic failure
- `string` — failure with that message
- `SchemaIssue.Issue` — a fully-formed issue
- `{ path, issue }` — failure at a nested path (`issue` is a `string` or `SchemaIssue.Issue`)
- `ReadonlyArray<Schema.FilterIssue>` — several failures reported together (empty array = success, single element is unwrapped, otherwise grouped into an `Issue.Composite`)

**Example** (Failure at a nested path)

```ts
import { Schema } from "effect"

const schema = Schema.Struct({ password: Schema.String, confirmPassword: Schema.String }).check(
  Schema.makeFilter((o) =>
    o.password === o.confirmPassword
      ? undefined
      : { path: ["password"], issue: "password and confirmPassword must match" }
  )
)

console.log(String(Schema.decodeUnknownExit(schema)({ password: "123456", confirmPassword: "1234567" })))
// Failure(Cause([Fail(SchemaError: password and confirmPassword must match
//   at ["password"])]))
```

**Example** (Reporting multiple failures at once)

```ts
import { Schema } from "effect"

const schema = Schema.Struct({ a: Schema.Finite, b: Schema.Finite, c: Schema.Finite }).check(
  Schema.makeFilter((o) => {
    const issues: Array<Schema.FilterIssue> = []
    if (o.a > 0) {
      if (o.b <= 0) issues.push({ path: ["b"], issue: "b must be greater than 0" })
      if (o.c <= 0) issues.push({ path: ["c"], issue: "c must be greater than 0" })
    }
    return issues
  })
)

console.log(String(Schema.decodeUnknownExit(schema)({ a: 1, b: 0, c: 0 })))
// Failure(Cause([Fail(SchemaError: b must be greater than 0
//   at ["b"]
// c must be greater than 0
//   at ["c"])]))
```

### filterEffect

**Migration: manual**

**New imports:** `SchemaGetter`, `Result`

v3

```ts
import { Effect, Schema } from "effect"

async function validateUsername(username: string) {
  return Promise.resolve(username === "gcanti")
}

const ValidUsername = Schema.String.pipe(
  Schema.filterEffect((username) =>
    Effect.promise(() => validateUsername(username).then((valid) => valid || "Invalid username"))
  )
)
```

v4

```ts
import { Effect, Result, Schema, SchemaGetter } from "effect"

async function validateUsername(username: string) {
  return Promise.resolve(username === "gcanti")
}

const ValidUsername = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((username) =>
      Effect.promise(() => validateUsername(username).then((valid) => valid || "Invalid username"))
    ),
    encode: SchemaGetter.passthrough()
  })
)
```

### transform

**Migration: semi-auto**

**New imports:** `SchemaTransformation`

v3

```ts
import { Schema } from "effect"

const BooleanFromString = Schema.transform(Schema.Literal("on", "off"), Schema.Boolean, {
  strict: true,
  decode: (literal) => literal === "on",
  encode: (bool) => (bool ? "on" : "off")
})
```

v4

```ts
import { Schema, SchemaTransformation } from "effect"

const BooleanFromString = Schema.Literals(["on", "off"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (literal) => literal === "on",
      encode: (bool) => (bool ? "on" : "off")
    })
  )
)
```

### transformOrFail

**Migration: semi-auto**

**New imports:** `SchemaGetter`, `SchemaIssue`

v3

```ts
import { ParseResult, Schema } from "effect"

const NumberFromString = Schema.transformOrFail(Schema.String, Schema.Number, {
  strict: true,
  decode: (input, _, ast) => {
    const parsed = parseFloat(input)
    if (isNaN(parsed)) {
      return ParseResult.fail(new ParseResult.Type(ast, input, "Failed to convert string to number"))
    }
    return ParseResult.succeed(parsed)
  },
  encode: (input) => ParseResult.succeed(input.toString())
})
```

v4

```ts
import { Effect, Number, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

const NumberFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformOrFail((s) => {
      const n = Number.parse(s)
      if (n === undefined) {
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(s)))
      }
      return Effect.succeed(n)
    }),
    encode: SchemaGetter.String()
  })
)
```

### transformLiteral / transformLiterals

**Migration: auto**

v3

```ts
import { Schema } from "effect"

const a = Schema.transformLiteral(0, "a")
const b = Schema.transformLiterals([0, "a"], [1, "b"], [2, "c"])
```

v4

```ts
import { Schema } from "effect"

const a = Schema.Literal(0).transform("a")
const b = Schema.Literals([0, 1, 2]).transform(["a", "b", "c"])
```

### attachPropertySignature

**Migration: semi-auto**

v3

```ts
import { Schema } from "effect"

const Circle = Schema.Struct({ radius: Schema.Number })
const Square = Schema.Struct({ sideLength: Schema.Number })

const DiscriminatedShape = Schema.Union(
  Circle.pipe(Schema.attachPropertySignature("kind", "circle")),
  Square.pipe(Schema.attachPropertySignature("kind", "square"))
)
```

v4

```ts
import { Schema } from "effect"

const Circle = Schema.Struct({ radius: Schema.Number })
const Square = Schema.Struct({ sideLength: Schema.Number })

const DiscriminatedShape = Schema.Union([
  Circle.mapFields((fields) => ({ ...fields, kind: Schema.tagDefaultOmit("circle") })),
  Square.mapFields((fields) => ({ ...fields, kind: Schema.tagDefaultOmit("square") }))
])
```

### decodingFallback

**Migration: auto**

v3

```ts
import { Effect, Schema } from "effect"

const schema = Schema.String.annotations({
  decodingFallback: () => Effect.succeed("a")
})
```

v4

```ts
import { Effect, Schema } from "effect"

const schema = Schema.String.pipe(Schema.catchDecoding(() => Effect.succeedSome("a")))
```

### rename

**Migration: manual**

**New imports:** `SchemaTransformation`

v3

```ts
import { Schema } from "effect"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.Number
}).pipe(Schema.rename({ a: "c" }))
```

v4

```ts
import { Schema } from "effect"

// experimental API
const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.Number
}).pipe(Schema.encodeKeys({ a: "c" }))
```

### Capitalize / Lowercase / Uppercase / Uncapitalize

**Migration: semi-auto**

**New imports:** `SchemaTransformation`

v3

```ts
import { Schema } from "effect"

const schema = Schema.Capitalize
```

v4

```ts
import { Schema, SchemaTransformation } from "effect"

const schema = Schema.String.pipe(
  Schema.decodeTo(Schema.String.check(Schema.isCapitalized()), SchemaTransformation.capitalize())
)
```

### NonEmptyTrimmedString

**Migration: semi-auto**

v3

```ts
import { Schema } from "effect"

const schema = Schema.NonEmptyTrimmedString
```

v4

```ts
import { Schema } from "effect"

const schema = Schema.Trimmed.check(Schema.isNonEmpty())
```

### split

**Migration: manual**

**New imports:** `SchemaTransformation`

v3

```ts
import { Schema } from "effect"

const schema = Schema.split(",")
```

v4

```ts
import { Schema, SchemaTransformation } from "effect"

function split(separator: string) {
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (s) => s.split(separator) as ReadonlyArray<string>,
        encode: (as) => as.join(separator)
      })
    )
  )
}
```
