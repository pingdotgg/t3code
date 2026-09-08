import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import * as SchemaTransformation from "effect/SchemaTransformation"
import assert from "node:assert/strict"

const size = 32
const input = Object.fromEntries(Array.from({ length: size }, (_, index) => [`field${index}`, `value${index}`]))

const makeEffectCheckedSchema = () =>
  Schema.Struct(
    Object.fromEntries(Array.from({ length: size }, (_, index) => [`field${index}`, Schema.NonEmptyString]))
  )

const makeEffectTemplateLiteralSchema = () =>
  Schema.TemplateLiteral(["prefix-", Schema.String, "-middle-", Schema.Number, "-suffix"])

const makeEffectRecordSchema = () => Schema.Record(Schema.String, Schema.String)

const literalValues100 = Array.from({ length: 100 }, (_, index) => `value${index}`)

const makeEffectLiteral100Schema = () => Schema.Literals(literalValues100)

const makeEffectTaggedMember = (index) =>
  Schema.Struct({
    kind: Schema.Literal(`kind${index}`),
    a: Schema.String,
    b: Schema.Number,
    c: Schema.Boolean
  })

const makeEffectTagged100Schema = () =>
  Schema.Union(Array.from({ length: 100 }, (_, index) => makeEffectTaggedMember(index)))

const taggedInput = {
  kind: "kind99",
  a: "a",
  b: 1,
  c: true
}

const makeEffectEncodingChain = (size) => {
  let schema = Schema.FiniteFromString
  for (let i = 1; i < size; i++) {
    schema = Schema.String.pipe(
      Schema.decodeTo(schema, SchemaTransformation.passthrough())
    )
  }
  return schema
}

export const effectSchemaCreationTemplateLiteral = () => ({
  run: makeEffectTemplateLiteralSchema,
  validate: (schema) => assert.equal(schema.ast._tag, "TemplateLiteral")
})

export const effectFirstDecodeCheckedObject32 = () => ({
  run: () => SchemaParser.decodeUnknownExit(makeEffectCheckedSchema())(input),
  validate: (result) => assert.equal(result._tag, "Success")
})

export const effectFirstDecodeTemplateLiteral = () => ({
  run: () => SchemaParser.decodeUnknownExit(makeEffectTemplateLiteralSchema())("prefix-value-middle-123-suffix"),
  validate: (result) => assert.equal(result._tag, "Success")
})

export const effectFirstDecodeRecord32 = () => ({
  run: () => SchemaParser.decodeUnknownExit(makeEffectRecordSchema())(input),
  validate: (result) => assert.equal(result._tag, "Success")
})

export const effectFirstDecodeLiteral100 = () => ({
  run: () => SchemaParser.decodeUnknownExit(makeEffectLiteral100Schema())("value99"),
  validate: (result) => assert.equal(result._tag, "Success")
})

export const effectFirstDecodeTagged100 = () => ({
  run: () => SchemaParser.decodeUnknownExit(makeEffectTagged100Schema())(taggedInput),
  validate: (result) => assert.equal(result._tag, "Success")
})

export const effectFirstDecodeEncodingChain8 = () => ({
  run: () => SchemaParser.decodeUnknownExit(makeEffectEncodingChain(8))("123"),
  validate: (result) => {
    assert.equal(result._tag, "Success")
    assert.equal(result.value, 123)
  }
})
