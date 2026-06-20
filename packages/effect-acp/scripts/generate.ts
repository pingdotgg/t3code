#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const CURRENT_SCHEMA_RELEASE = "v0.11.3";

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly upstreamSchemaPath: string;
  readonly upstreamMetaPath: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
}

const urlDiagnosticsSchema = {
  urlInputLength: Schema.Number,
  urlProtocol: Schema.optionalKey(Schema.String),
  urlHostname: Schema.optionalKey(Schema.String),
};

function urlDiagnosticFields(url: string) {
  const diagnostics = getUrlDiagnostics(url);
  return {
    urlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { urlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { urlHostname: diagnostics.hostname }),
  };
}

export class AcpGeneratorDownloadError extends Schema.TaggedErrorClass<AcpGeneratorDownloadError>()(
  "AcpGeneratorDownloadError",
  {
    ...urlDiagnosticsSchema,
    outputPath: Schema.String,
    stage: Schema.Literals(["request", "read-response"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const source = this.urlHostname === undefined ? "the configured source" : this.urlHostname;
    return `Failed to download the ACP generator input from ${source} to ${this.outputPath} during ${this.stage}.`;
  }
}

export class AcpGeneratorDownloadFileError extends Schema.TaggedErrorClass<AcpGeneratorDownloadFileError>()(
  "AcpGeneratorDownloadFileError",
  {
    ...urlDiagnosticsSchema,
    outputPath: Schema.String,
    stage: Schema.Literals(["create-directory", "write-file"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to store the ACP generator download at ${this.outputPath} during ${this.stage}.`;
  }
}

export class AcpGeneratorDocumentDecodeError extends Schema.TaggedErrorClass<AcpGeneratorDocumentDecodeError>()(
  "AcpGeneratorDocumentDecodeError",
  {
    document: Schema.Literals(["schema", "metadata"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the upstream ACP ${this.document} document at ${this.filePath}.`;
  }
}

export class AcpGeneratorFormatProcessError extends Schema.TaggedErrorClass<AcpGeneratorFormatProcessError>()(
  "AcpGeneratorFormatProcessError",
  {
    stage: Schema.Literals(["spawn", "wait-for-exit"]),
    command: Schema.String,
    argumentCount: Schema.Number,
    generatedDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `ACP generator formatting command ${this.command} failed during ${this.stage} for ${this.generatedDir}.`;
  }
}

export class AcpGeneratorFormatExitError extends Schema.TaggedErrorClass<AcpGeneratorFormatExitError>()(
  "AcpGeneratorFormatExitError",
  {
    command: Schema.String,
    argumentCount: Schema.Number,
    generatedDir: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `ACP generator formatting command ${this.command} exited with code ${this.exitCode} for ${this.generatedDir}.`;
  }
}

export class AcpGeneratorSchemaValueDeclarationMissingError extends Schema.TaggedErrorClass<AcpGeneratorSchemaValueDeclarationMissingError>()(
  "AcpGeneratorSchemaValueDeclarationMissingError",
  {
    lineIndex: Schema.Number,
    typeDeclarationLength: Schema.Number,
    nextLinePresent: Schema.Boolean,
    nextLineLength: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Generated ACP schema type declaration at line ${this.lineIndex + 1} has no following value declaration.`;
  }
}

export class AcpGeneratorSchemaNameParseError extends Schema.TaggedErrorClass<AcpGeneratorSchemaNameParseError>()(
  "AcpGeneratorSchemaNameParseError",
  {
    lineIndex: Schema.Number,
    typeDeclarationLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Could not extract an ACP schema name from generated declaration at line ${this.lineIndex + 1}.`;
  }
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
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();

  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

export const downloadFile = Effect.fn("downloadFile")(function* (url: string, outputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new AcpGeneratorDownloadFileError({
          ...urlDiagnosticFields(url),
          outputPath,
          stage: "create-directory",
          cause,
        }),
    ),
  );

  const response = yield* HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError(
      (cause) =>
        new AcpGeneratorDownloadError({
          ...urlDiagnosticFields(url),
          outputPath,
          stage: "request",
          cause,
        }),
    ),
  );
  const text = yield* response.text.pipe(
    Effect.mapError(
      (cause) =>
        new AcpGeneratorDownloadError({
          ...urlDiagnosticFields(url),
          outputPath,
          stage: "read-response",
          cause,
        }),
    ),
  );

  yield* fs.writeFileString(outputPath, text).pipe(
    Effect.mapError(
      (cause) =>
        new AcpGeneratorDownloadFileError({
          ...urlDiagnosticFields(url),
          outputPath,
          stage: "write-file",
          cause,
        }),
    ),
  );
});

const downloadSchemas = Effect.fn("downloadSchemas")(function* (tag: string) {
  const { upstreamMetaPath, upstreamSchemaPath } = yield* getGeneratedPaths();
  const fs = yield* FileSystem.FileSystem;
  const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${tag}`;

  yield* Effect.addFinalizer(() =>
    Effect.all([fs.remove(upstreamSchemaPath), fs.remove(upstreamMetaPath)]).pipe(
      Effect.ignoreCause({ log: true }),
    ),
  );

  yield* downloadFile(`${baseUrl}/schema.unstable.json`, upstreamSchemaPath);
  yield* downloadFile(`${baseUrl}/meta.unstable.json`, upstreamMetaPath);
});

const readFileString = Effect.fn("readJsonFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath);
});

export const decodeUpstreamSchemaDocument = Effect.fn("decodeUpstreamSchemaDocument")(function* (
  raw: string,
  filePath: string,
) {
  return yield* decodeUpstreamSchema(raw).pipe(
    Effect.mapError(
      (cause) => new AcpGeneratorDocumentDecodeError({ document: "schema", filePath, cause }),
    ),
  );
});

export const decodeMetaDocument = Effect.fn("decodeMetaDocument")(function* (
  raw: string,
  filePath: string,
) {
  return yield* decodeMetaJson(raw).pipe(
    Effect.mapError(
      (cause) => new AcpGeneratorDocumentDecodeError({ document: "metadata", filePath, cause }),
    ),
  );
});

export const formatGeneratedFiles = Effect.fn("formatGeneratedFiles")(function* (
  generatedDir: string,
) {
  const command = "bun";
  const args = ["oxfmt", generatedDir];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args)).pipe(
    Effect.mapError(
      (cause) =>
        new AcpGeneratorFormatProcessError({
          stage: "spawn",
          command,
          argumentCount: args.length,
          generatedDir,
          cause,
        }),
    ),
  );
  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new AcpGeneratorFormatProcessError({
          stage: "wait-for-exit",
          command,
          argumentCount: args.length,
          generatedDir,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new AcpGeneratorFormatExitError({
      command,
      argumentCount: args.length,
      generatedDir,
      exitCode,
    });
  }
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

export const collectSchemaEntries = Effect.fn("collectSchemaEntries")(function* (chunk: string) {
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
      return yield* new AcpGeneratorSchemaValueDeclarationMissingError({
        lineIndex: index,
        typeDeclarationLength: typeLine.length,
        nextLinePresent: constLine !== undefined,
        ...(constLine === undefined ? {} : { nextLineLength: constLine.length }),
      });
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      return yield* new AcpGeneratorSchemaNameParseError({
        lineIndex: index,
        typeDeclarationLength: typeLine.length,
      });
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
});

function normalizeNullableTypes(value: Schema.Json): Schema.Json {
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
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
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

  const nextObject: Record<string, Schema.Json> = {};
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

  const upstreamSchemaRaw = yield* readFileString(upstreamSchemaPath);
  const upstreamSchema = yield* decodeUpstreamSchemaDocument(upstreamSchemaRaw, upstreamSchemaPath);
  const upstreamMetaRaw = yield* readFileString(upstreamMetaPath);
  const upstreamMeta = yield* decodeMetaDocument(upstreamMetaRaw, upstreamMetaPath);
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
    const schemaEntries = yield* collectSchemaEntries(output);
    for (const entry of schemaEntries) {
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
    `export const AGENT_METHODS = ${yield* encodeAgentMethods(upstreamMeta.agentMethods)} as const;`,
    "",
    `export const CLIENT_METHODS = ${yield* encodeClientMethods(upstreamMeta.clientMethods)} as const;`,
    "",
    `export const PROTOCOL_VERSION = ${yield* encodeVersion(upstreamMeta.version)} as const;`,
    "",
  ].join("\n");

  yield* writeGeneratedFiles(schemaOutput, metaOutput);
  yield* Effect.log(
    `Generated ${generatedEntries.size} ACP schemas from ${CURRENT_SCHEMA_RELEASE}`,
  );

  const { generatedDir } = yield* getGeneratedPaths();
  yield* formatGeneratedFiles(generatedDir);
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

if (import.meta.main) {
  Command.run(generateCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(runtimeLayer),
    NodeRuntime.runMain,
  );
}
