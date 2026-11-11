import { format } from "vite-plus/fmt";
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
  const code = Representation.toCodeDocument(JSON.parse(json));
  const source = [
    "// Generated from T3 service schemas by apps/server/scripts/extensionHostApi.ts.",
    ...code.references.nonRecursives.map(({ $ref, code }) => `type ${$ref} = ${code.Type};`),
    ...Object.entries(code.references.recursives).map(
      ([name, code]) => `type ${name} = ${code.Type};`,
    ),
    ...Object.keys(hostApiSchemas).map(
      (name, index) => `export type ${name} = ${code.codes[index]!.Type};`,
    ),
    "",
  ].join("\n");
  const result = await format("hostApi.generated.ts", source);
  if (result.errors.length > 0)
    throw new Error("The generated extension API could not be formatted.");
  return result.code;
}
