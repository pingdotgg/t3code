import { MANAGED_POLICY_SCHEMA_URL, ManagedPolicyDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export function buildManagedPolicyJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(ManagedPolicyDocument, {
    onExcessProperty: "error",
  });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: MANAGED_POLICY_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
