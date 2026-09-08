import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import assert from "node:assert/strict"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.Number
})
const input = { a: "a", b: 1 }
const invalidInput = { a: "a", b: "invalid" }

export const parserExitInvalid = () => {
  const run = SchemaParser.decodeUnknownExit(schema)
  return {
    run: () => run(invalidInput),
    validate: (result) => assert.equal(result._tag, "Failure")
  }
}

export const exitValid = () => {
  const run = Schema.decodeUnknownExit(schema)
  return {
    run: () => run(input),
    validate: (result) => assert.equal(result._tag, "Success")
  }
}

export const exitInvalid = () => {
  const run = Schema.decodeUnknownExit(schema)
  return {
    run: () => run(invalidInput),
    validate: (result) => assert.equal(result._tag, "Failure")
  }
}

export const optionValid = () => {
  const run = Schema.decodeUnknownOption(schema)
  return {
    run: () => run(input),
    validate: (result) => assert.equal(Option.isSome(result), true)
  }
}

export const optionInvalid = () => {
  const run = Schema.decodeUnknownOption(schema)
  return {
    run: () => run(invalidInput),
    validate: (result) => assert.equal(Option.isNone(result), true)
  }
}

export const resultValid = () => {
  const run = Schema.decodeUnknownResult(schema)
  return {
    run: () => run(input),
    validate: (result) => assert.equal(Result.isSuccess(result), true)
  }
}

export const resultInvalid = () => {
  const run = Schema.decodeUnknownResult(schema)
  return {
    run: () => run(invalidInput),
    validate: (result) => assert.equal(Result.isFailure(result), true)
  }
}

export const syncInvalid = () => {
  const run = Schema.decodeUnknownSync(schema)
  return {
    run: () => {
      try {
        run(invalidInput)
      } catch (error) {
        return error
      }
      return undefined
    },
    validate: (result) => assert.equal(result instanceof Error, true)
  }
}
