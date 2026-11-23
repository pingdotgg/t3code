import { format } from "vite-plus/fmt";
import * as Codegen from "effect/Codegen";
import * as Schema from "effect/Schema";
import * as Representation from "effect/SchemaRepresentation";
import { hostApiSchemas } from "../src/extensions/hostApiSchemas.ts";

export async function generateExtensionHostApi(): Promise<string> {
  let next = 0;
  const representation = Representation.toRepresentations(
    [
      Schema.toEncoded(hostApiSchemas.ProjectSnapshot).ast,
      ...Object.values(hostApiSchemas)
        .slice(1)
        .map((schema) => Schema.toEncoded(schema).ast),
    ],
    {
      referencePolicy: ({ ast, occurrences }) =>
        occurrences > 1 && ["Objects", "Arrays", "Union"].includes(ast._tag)
          ? `Wire${++next}`
          : undefined,
    },
  );
  // Validation belongs to the service boundary; SDK types describe JSON, including ISO dates.
  const json = JSON.stringify(representation, (key, value) => {
    if (key === "checks") return [];
    if (key === "annotations") return {};
    if (value?._tag === "Declaration" && value.representation?.id === "effect/schema/DateTimeUtc")
      return { _tag: "String", checks: [], annotations: {} };
    return value;
  });
  const document: Representation.MultiDocument = JSON.parse(json, (_key, value) => {
    if (value?._tag === "Declaration" && value.representation?.id === "effect/schema/Json") {
      value.annotations.toCode = () => ({
        Type: "Json",
        runtime: "undefined",
        importDeclarations: ['import type { Json } from "./index.ts"'],
      });
    }
    return value;
  });
  const module = new Codegen.Module();
  const schemas = Object.fromEntries(
    Object.keys(hostApiSchemas).map((name, index) => [name, document.representations[index]!]),
  );
  module.addSchemas(schemas, { references: document.references, typeOnly: true });
  const source =
    "// Generated from T3 service schemas by apps/server/scripts/extensionHostApi.ts.\n" +
    module.print();
  const result = await format("hostApi.generated.ts", source);
  if (result.errors.length > 0)
    throw new Error("The generated extension API could not be formatted.");
  return result.code;
}
