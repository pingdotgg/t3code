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

const templateLiteral256Parts = Array.from({ length: 256 }, (_, index) => Schema.Literal(`part${index}`))
const makeEffectTemplateLiteral256Schema = () => Schema.TemplateLiteral(templateLiteral256Parts)

const makeEffectRecordSchema = () => Schema.Record(Schema.String, Schema.String)
const makeEffectEncodedRecordSchema = () =>
  Schema.Record(
    Schema.String.pipe(Schema.decodeTo(Schema.Number, SchemaTransformation.passthrough())),
    Schema.String
  )

const makeEffectObject2Schema = () =>
  Schema.Struct({
    name: Schema.String,
    age: Schema.Number
  })

const makeObjectFields = (size: number) =>
  Object.fromEntries(Array.from({ length: size }, (_, index) => [`field${index}`, Schema.NonEmptyString]))

const object32Fields = makeObjectFields(32)
const object256Fields = makeObjectFields(256)

const makeEffectObject32Schema = () => Schema.Struct(object32Fields)
const makeEffectObject256Schema = () => Schema.Struct(object256Fields)

const object2Input = { name: "John", age: 42 }

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

export const effectSchemaCreationTemplateLiteral256 = () => ({
  run: makeEffectTemplateLiteral256Schema,
  validate: (schema) => assert.equal(schema.ast._tag, "TemplateLiteral")
})

export const effectSchemaCreationObject2 = () => ({
  run: makeEffectObject2Schema,
  validate: (schema) => assert.equal(schema.ast._tag, "Objects")
})

export const effectSchemaCreationObject32 = () => ({
  run: makeEffectObject32Schema,
  validate: (schema) => assert.equal(schema.ast._tag, "Objects")
})

export const effectSchemaCreationObject256 = () => ({
  run: makeEffectObject256Schema,
  validate: (schema) => assert.equal(schema.ast._tag, "Objects")
})

export const effectSchemaCreationEncodedRecord = () => ({
  run: makeEffectEncodedRecordSchema,
  validate: (schema) => assert.equal(schema.ast._tag, "Objects")
})

export const effectFirstMakeObject2 = () => ({
  run: () => makeEffectObject2Schema().make(object2Input),
  validate: (result) => assert.deepEqual(result, object2Input)
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
