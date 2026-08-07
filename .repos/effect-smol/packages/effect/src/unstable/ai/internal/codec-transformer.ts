import * as JsonSchema from "../../../JsonSchema.ts"
import * as Schema from "../../../Schema.ts"
import type { CodecTransformer } from "../LanguageModel.ts"

const makeDefaultCodecTransformer = (
  toJsonSchemaDocument: (schema: Schema.Constraint) => JsonSchema.Document<"draft-2020-12">
): CodecTransformer => {
  return (codec) => {
    const document = JsonSchema.resolveTopLevel$ref(toJsonSchemaDocument(codec))
    const jsonSchema = { ...document.schema }
    if (Object.keys(document.definitions).length > 0) {
      jsonSchema.$defs = document.definitions
    }
    return { codec, jsonSchema }
  }
}

/** @internal */
export const defaultCodecTransformer = makeDefaultCodecTransformer(Schema.toJsonSchemaDocument)
