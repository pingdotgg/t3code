import { Schema } from "effect";

export function toTextGenerationOutputJsonSchema(schema: Schema.Top): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema);
  const baseSchema = document.schema as Record<string, unknown>;
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...baseSchema,
      $defs: document.definitions,
    };
  }
  return baseSchema;
}
