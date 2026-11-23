import { format } from "vite-plus/fmt";
import * as Codegen from "effect/Codegen";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Representation from "effect/SchemaRepresentation";
import { hostApiSchemas } from "../src/extensions/hostApiSchemas.ts";

class ExtensionHostApiGenerationError extends Schema.TaggedError<ExtensionHostApiGenerationError>()(
  "ExtensionHostApiGenerationError",
  {
    stage: Schema.Literals(["generate", "format"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.stage === "generate"
      ? "Could not generate the extension host API types."
      : "Could not format the extension host API types.";
  }
}

function extensionHostApiSource(): string {
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
  return (
    "// Generated from T3 service schemas by apps/server/scripts/extensionHostApi.ts.\n" +
    module.print()
  );
}

export const generateExtensionHostApi = Effect.fn("generateExtensionHostApi")(function* () {
  const source = yield* Effect.try({
    try: extensionHostApiSource,
    catch: (cause) => new ExtensionHostApiGenerationError({ stage: "generate", cause }),
  });
  const result = yield* Effect.tryPromise({
    try: () => format("hostApi.generated.ts", source),
    catch: (cause) => new ExtensionHostApiGenerationError({ stage: "format", cause }),
  });
  if (result.errors.length > 0) {
    return yield* new ExtensionHostApiGenerationError({ stage: "format", cause: result.errors });
  }
  return result.code;
});
