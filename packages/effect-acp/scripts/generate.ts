#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import { Effect, FileSystem, Layer, Logger, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const CURRENT_SCHEMA_RELEASE = "v0.11.3";

interface GenerateCommandError {
  readonly _tag: "GenerateCommandError";
  readonly message: string;
}

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly upstreamSchemaPath: string;
  readonly upstreamMetaPath: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
}

const MetaJsonSchema = Schema.Struct({
  agentMethods: Schema.Record(Schema.String, Schema.String),
  clientMethods: Schema.Record(Schema.String, Schema.String),
  version: Schema.Union([Schema.Number, Schema.String]),
});

const UpstreamJsonSchemaSchema = Schema.Struct({
  $defs: Schema.Record(Schema.String, Schema.Json),
});

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    upstreamSchemaPath: path.join(generatedDir, "upstream-schema.json"),
    upstreamMetaPath: path.join(generatedDir, "upstream-meta.json"),
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();

  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

const downloadFile = Effect.fn("downloadFile")(function* (url: string, outputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });

  const text = yield* HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
  );

  yield* fs.writeFileString(outputPath, text);
});

const downloadSchemas = Effect.fn("downloadSchemas")(function* (tag: string) {
  const { upstreamMetaPath, upstreamSchemaPath } = yield* getGeneratedPaths();
  const fs = yield* FileSystem.FileSystem;
  const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${tag}`;

  yield* downloadFile(`${baseUrl}/schema.unstable.json`, upstreamSchemaPath);
  yield* downloadFile(`${baseUrl}/meta.unstable.json`, upstreamMetaPath);

  yield* Effect.addFinalizer(() =>
    Effect.all([fs.remove(upstreamSchemaPath), fs.remove(upstreamMetaPath)]).pipe(
      Effect.ignoreCause({ log: true }),
    ),
  );
});

const readJsonFile = Effect.fn("readJsonFile")(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(schema: S, filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath);
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(raw);
});

const writeGeneratedFiles = Effect.fn("writeGeneratedFiles")(function* (
  schemaOutput: string,
  metaOutput: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { metaOutputPath, schemaOutputPath } = yield* getGeneratedPaths();

  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
});

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function normalizeNullableTypes(value: typeof Schema.Json.Type): typeof Schema.Json.Type {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeNullableTypes(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<
    string,
    typeof Schema.Json.Type
  >;
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, typeof Schema.Json.Type> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

const generateSchemas = Effect.fn("generateSchemas")(function* (skipDownload: boolean) {
  const { upstreamMetaPath, upstreamSchemaPath } = yield* getGeneratedPaths();

  yield* ensureGeneratedDir();

  if (!skipDownload) {
    yield* Effect.log(`Downloading ACP schema assets for ${CURRENT_SCHEMA_RELEASE}`);
    yield* downloadSchemas(CURRENT_SCHEMA_RELEASE);
  }

  const upstreamSchema = yield* readJsonFile(UpstreamJsonSchemaSchema, upstreamSchemaPath);
  const upstreamMeta = yield* readJsonFile(MetaJsonSchema, upstreamMetaPath);
  const normalizedDefinitions = Object.fromEntries(
    Object.entries(upstreamSchema.$defs).map(([name, schema]) => [
      name,
      normalizeNullableTypes(schema),
    ]),
  );

  const sortedEntries = Object.entries(normalizedDefinitions).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const generatedEntries = new Map<string, string>();
  const generator = makeJsonSchemaGenerator();

  for (const [name, schema] of sortedEntries) {
    generator.addSchema(name, schema as never);
  }

  const output = generator.generate("openapi-3.1", normalizedDefinitions as never, false).trim();
  if (output.length > 0) {
    for (const entry of collectSchemaEntries(output)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  const prelude = [
    `// This file is generated by the effect-acp package. Do not edit manually.`,
    `// Current ACP schema release: ${CURRENT_SCHEMA_RELEASE}`,
    "",
  ];

  const schemaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    "",
    [...generatedEntries.values()].join("\n\n"),
    "",
  ].join("\n");

  const metaOutput = [
    ...prelude,
    `export const AGENT_METHODS = ${yield* Schema.encodeEffect(Schema.fromJsonString(MetaJsonSchema.fields.agentMethods))(upstreamMeta.agentMethods)} as const;`,
    "",
    `export const CLIENT_METHODS = ${yield* Schema.encodeEffect(Schema.fromJsonString(MetaJsonSchema.fields.clientMethods))(upstreamMeta.clientMethods)} as const;`,
    "",
    `export const PROTOCOL_VERSION = ${yield* Schema.encodeEffect(Schema.fromJsonString(MetaJsonSchema.fields.version))(upstreamMeta.version)} as const;`,
    "",
  ].join("\n");

  yield* writeGeneratedFiles(schemaOutput, metaOutput);
  yield* Effect.log(
    `Generated ${generatedEntries.size} ACP schemas from ${CURRENT_SCHEMA_RELEASE}`,
  );

  const { generatedDir } = yield* getGeneratedPaths();
  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) => spawner.spawn(ChildProcess.make("bun", ["oxfmt", generatedDir]))),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail<GenerateCommandError>({
            _tag: "GenerateCommandError",
            message: `oxfmt failed with exit code ${code}`,
          }),
    ),
  );
});

const generateCommand = Command.make(
  "generate",
  {
    skipDownload: Flag.boolean("skip-download").pipe(Flag.withDefault(false)),
  },
  ({ skipDownload }) => generateSchemas(skipDownload),
).pipe(Command.withDescription("Generate Effect ACP schemas from the pinned ACP release assets."));

const runtimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  FetchHttpClient.layer,
);

Command.run(generateCommand, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain,
);
