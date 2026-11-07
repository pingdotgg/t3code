#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { generateSchemaOutput } from "./schemaTransform.ts";

const V2_SCHEMA_RELEASE = "schema-v2.0.0-alpha.3";
const V1_SCHEMA_RELEASE = "schema-v1.21.0";

interface GenerateCommandError {
  readonly _tag: "GenerateCommandError";
  readonly message: string;
}

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly upstreamSchemaPath: string;
  readonly upstreamMetaPath: string;
  readonly upstreamV1SchemaPath: string;
  readonly upstreamV1MetaPath: string;
  readonly schemaOutputPath: string;
  readonly v1SchemaOutputPath: string;
  readonly metaOutputPath: string;
}

const UpstreamJsonSchemaSchema = Schema.Struct({
  $defs: Schema.Record(Schema.String, Schema.Json),
});
const MetaJsonSchema = Schema.Struct({
  agentMethods: Schema.Record(Schema.String, Schema.String),
  clientMethods: Schema.Record(Schema.String, Schema.String),
  version: Schema.Union([Schema.Number, Schema.String]),
});
const encodeAgentMethods = Schema.encodeEffect(
  Schema.fromJsonString(MetaJsonSchema.fields.agentMethods),
);
const encodeClientMethods = Schema.encodeEffect(
  Schema.fromJsonString(MetaJsonSchema.fields.clientMethods),
);
const encodeVersion = Schema.encodeEffect(Schema.fromJsonString(MetaJsonSchema.fields.version));

const decodeUpstreamSchema = Schema.decodeEffect(Schema.fromJsonString(UpstreamJsonSchemaSchema));
const decodeMetaJson = Schema.decodeEffect(Schema.fromJsonString(MetaJsonSchema));

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    upstreamSchemaPath: path.join(generatedDir, "upstream-schema.json"),
    upstreamMetaPath: path.join(generatedDir, "upstream-meta.json"),
    upstreamV1SchemaPath: path.join(generatedDir, "upstream-schema-v1.json"),
    upstreamV1MetaPath: path.join(generatedDir, "upstream-meta-v1.json"),
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    v1SchemaOutputPath: path.join(generatedDir, "schema-v1.gen.ts"),
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

const downloadSchemas = Effect.fn("downloadSchemas")(function* (
  tag: string,
  paths: { readonly schema: string; readonly meta: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${tag}`;

  yield* Effect.all(
    [
      downloadFile(`${baseUrl}/schema.unstable.json`, paths.schema),
      downloadFile(`${baseUrl}/meta.unstable.json`, paths.meta),
    ],
    { concurrency: 2 },
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([fs.remove(paths.schema), fs.remove(paths.meta)]).pipe(
      Effect.ignoreCause({ log: true }),
    ),
  );
});

const readFileString = Effect.fn("readJsonFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath);
});

const writeGeneratedFiles = Effect.fn("writeGeneratedFiles")(function* (
  schemaOutput: string,
  v1SchemaOutput: string,
  metaOutput: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { metaOutputPath, schemaOutputPath, v1SchemaOutputPath } = yield* getGeneratedPaths();

  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(v1SchemaOutputPath, v1SchemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
});

const generateSchemas = Effect.fn("generateSchemas")(function* (skipDownload: boolean) {
  const { upstreamMetaPath, upstreamSchemaPath, upstreamV1MetaPath, upstreamV1SchemaPath } =
    yield* getGeneratedPaths();

  yield* ensureGeneratedDir();

  if (!skipDownload) {
    yield* Effect.log(
      `Downloading ACP schema assets for ${V2_SCHEMA_RELEASE} and ${V1_SCHEMA_RELEASE}`,
    );
    yield* Effect.all(
      [
        downloadSchemas(V2_SCHEMA_RELEASE, {
          schema: upstreamSchemaPath,
          meta: upstreamMetaPath,
        }),
        downloadSchemas(V1_SCHEMA_RELEASE, {
          schema: upstreamV1SchemaPath,
          meta: upstreamV1MetaPath,
        }),
      ],
      { concurrency: 2 },
    );
  }

  const upstreamSchema = yield* readFileString(upstreamSchemaPath).pipe(
    Effect.flatMap(decodeUpstreamSchema),
  );
  const upstreamV1Schema = yield* readFileString(upstreamV1SchemaPath).pipe(
    Effect.flatMap(decodeUpstreamSchema),
  );
  const upstreamMeta = yield* readFileString(upstreamMetaPath).pipe(Effect.flatMap(decodeMetaJson));
  const v2Schema = generateSchemaOutput(upstreamSchema, V2_SCHEMA_RELEASE);
  const v1Schema = generateSchemaOutput(upstreamV1Schema, V1_SCHEMA_RELEASE);

  const prelude = [
    `// This file is generated by the effect-acp package. Do not edit manually.`,
    `// Current ACP schema release: ${V2_SCHEMA_RELEASE}`,
    "",
  ];

  const metaOutput = [
    ...prelude,
    `export const AGENT_METHODS = ${yield* encodeAgentMethods(upstreamMeta.agentMethods)} as const;`,
    "",
    `export const CLIENT_METHODS = ${yield* encodeClientMethods(upstreamMeta.clientMethods)} as const;`,
    "",
    `export const PROTOCOL_VERSION = ${yield* encodeVersion(upstreamMeta.version)} as const;`,
    "",
  ].join("\n");

  yield* writeGeneratedFiles(v2Schema.output, v1Schema.output, metaOutput);
  yield* Effect.log(
    `Generated ${v2Schema.count} ACP v2 schemas and ${v1Schema.count} ACP v1 compatibility schemas`,
  );

  const { generatedDir } = yield* getGeneratedPaths();
  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(
        ChildProcess.make("pnpm", ["exec", "vp", "fmt", generatedDir], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      ),
    ),
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
    skipDownload: Flag.Boolean("skip-download").pipe(Flag.withDefault(false)),
  },
  ({ skipDownload }) => generateSchemas(skipDownload),
).pipe(Command.withDescription("Generate Effect ACP schemas from the pinned ACP release assets."));

const layerRuntime = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  FetchHttpClient.layer,
);

Command.run(generateCommand, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(layerRuntime),
  NodeRuntime.runMain,
);
