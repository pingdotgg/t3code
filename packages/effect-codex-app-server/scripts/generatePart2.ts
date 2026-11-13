#!/usr/bin/env node
import { pipe } from "effect/Function";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export const UPSTREAM_REF = "687a119f0fcaace47e1f1abcc77cec6c813fd6da";

const USER_AGENT = "effect-codex-app-server-generator";

const GITHUB_API_BASE =
  "https://api.github.com/repos/openai/codex/contents/codex-rs/app-server-protocol";

const GithubContentEntries = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    download_url: Schema.NullOr(Schema.String),
    type: Schema.String,
  }),
);

export type GithubContentEntry = (typeof GithubContentEntries.Type)[number];

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const decodeGithubContentEntries = Schema.decodeEffect(Schema.fromJsonString(GithubContentEntries));

export const decodeJsonSchemaDocument = Schema.decodeEffect(Schema.fromJsonString(JsonSchemaDocument));

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

export interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

export interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly downloadUrl: string;
  readonly qualifiedName: string;
}

export class GeneratorError extends Schema.TaggedError<GeneratorError>()("GeneratorError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export const ManualSchemas: Record<string, Schema.Json> = {
  GetAuthStatusParams: {
    type: "object",
    title: "GetAuthStatusParams",
    properties: {
      includeToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
      refreshToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
  },
  GetConversationSummaryParams: {
    title: "GetConversationSummaryParams",
    oneOf: [
      {
        type: "object",
        properties: {
          rolloutPath: { type: "string" },
        },
        required: ["rolloutPath"],
      },
      {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    ],
  },
  GetConversationSummaryResponse: {
    type: "object",
    title: "GetConversationSummaryResponse",
    properties: {
      summary: {},
    },
    required: ["summary"],
  },
  GitDiffToRemoteParams: {
    type: "object",
    title: "GitDiffToRemoteParams",
    properties: {
      cwd: { type: "string" },
    },
    required: ["cwd"],
  },
  GitDiffToRemoteResponse: {
    type: "object",
    title: "GitDiffToRemoteResponse",
    properties: {
      sha: { type: "string" },
      diff: { type: "string" },
    },
    required: ["sha", "diff"],
  },
  GetAuthStatusResponse: {
    type: "object",
    title: "GetAuthStatusResponse",
    properties: {
      authMethod: {
        anyOf: [{}, { type: "null" }],
      },
      authToken: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      requiresOpenaiAuth: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
  },
};

export // T3 Code only uses the plan for labels, so an unknown slug must not fail the whole
// `account/read` decode and take the provider down with it.
const DefinitionOverrides: Record<string, Schema.Json> = {
  PlanType: { type: "string" },
  // Newer custom Codex binaries emit partial answers before additional tools or text.
  MessagePhase: {
    description:
      'Classifies an assistant message as interim commentary or final answer text.\n\nProviders do not emit this consistently, so callers must treat `None` as "phase unknown" and keep compatibility behavior for legacy models.',
    oneOf: [
      {
        type: "string",
        enum: ["commentary"],
        description:
          "Mid-turn assistant text (for example preamble/progress narration).\n\nAdditional tool calls or assistant output may follow before turn completion.",
      },
      {
        type: "string",
        enum: ["partial_answer"],
        description: "Stable answer text that may be followed by more assistant output or tools.",
      },
      {
        type: "string",
        enum: ["final_answer"],
        description: "The assistant's terminal answer text for the current turn.",
      },
    ],
  },
};

export // Codex sends error codes this ref does not list yet (e.g. `modelNotFound`). A closed enum
// fails the whole notification decode, which drops a failed `turn/completed` and leaves the turn running.
const OpenStringEnumDefinitions = new Set(["CodexErrorInfo"]);

export function openStringEnum(schema: Schema.Json): Schema.Json {
  if (!isJsonSchemaNode(schema) || !Array.isArray(schema.oneOf)) return schema;
  return {
    ...schema,
    oneOf: schema.oneOf.map((variant: Schema.Json) =>
      isJsonSchemaNode(variant) && variant.type === "string" && Array.isArray(variant.enum)
        ? { type: "string" }
        : variant,
    ),
  };
}

export const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
    namespacesOutputPath: path.join(generatedDir, "namespaces.gen.ts"),
  } satisfies GeneratedPaths;
});

export const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();
  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

export const fetchText = Effect.fn("fetchText")(function* (url: string) {
  const token = process.env.GITHUB_TOKEN;
  return yield* HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("user-agent", USER_AGENT),
    token && url.startsWith("https://api.github.com/")
      ? HttpClientRequest.bearerToken(token)
      : (request) => request,
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((okResponse) => okResponse.text),
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: `Failed to fetch ${url}`,
          cause,
        }),
    ),
  );
});

export const fetchDirectoryEntries = Effect.fn("fetchDirectoryEntries")(function* (path: string) {
  const raw = yield* fetchText(`${GITHUB_API_BASE}/${path}?ref=${UPSTREAM_REF}`);
  return yield* decodeGithubContentEntries(raw);
});

export function collectSchemaEntries(
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

export function normalizeNullableTypes(value: Schema.Json): Schema.Json {
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

export function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  ) as Schema.Json;
}

type JsonSchemaNode = { readonly [key: string]: Schema.Json };

function isJsonSchemaNode(value: Schema.Json | undefined): value is JsonSchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export // Visit only schema positions so fields literally named properties stay untouched.
// Close Codex structs that omit additionalProperties; Effect otherwise imports open records.
// Fold shared fields into each object alternative because Effect cannot intersect them.
function adaptSchemaForEffect(value: Schema.Json): Schema.Json {
  if (!isJsonSchemaNode(value)) {
    return value;
  }
  const node: Record<string, Schema.Json> = { ...value };
  for (const key of ["items", "additionalProperties"]) {
    const child = node[key];
    if (isJsonSchemaNode(child)) node[key] = adaptSchemaForEffect(child);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const child = node[key];
    if (Array.isArray(child)) node[key] = child.map(adaptSchemaForEffect);
  }
  for (const key of ["properties", "definitions"]) {
    const child = node[key];
    if (isJsonSchemaNode(child)) {
      node[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, adaptSchemaForEffect(schema)]),
      );
    }
  }

  const { properties } = node;
  if (
    isJsonSchemaNode(properties) &&
    Object.keys(properties).length > 0 &&
    !("additionalProperties" in node)
  ) {
    node.additionalProperties = false;
  }

  const alternativesKey = "anyOf" in node ? "anyOf" : "oneOf";
  const alternatives = node[alternativesKey];
  if (
    !isJsonSchemaNode(properties) ||
    !Array.isArray(alternatives) ||
    !alternatives.every(
      (alternative) => isJsonSchemaNode(alternative) && alternative.type === "object",
    )
  ) {
    return node;
  }
  const {
    properties: _shared,
    required,
    type: _type,
    additionalProperties: _closed,
    ...rest
  } = node;
  const sharedRequired = Array.isArray(required) ? required : [];
  return {
    ...rest,
    [alternativesKey]: alternatives.map((alternative) => {
      const branch = alternative as JsonSchemaNode;
      const branchProperties = isJsonSchemaNode(branch.properties) ? branch.properties : {};
      const branchRequired = Array.isArray(branch.required) ? branch.required : [];
      return {
        ...branch,
        properties: { ...properties, ...branchProperties },
        required: [...new Set([...sharedRequired, ...branchRequired])],
      };
    }),
  };
}

export function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

export function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params(\??):\s*([^,}|]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      paramsType: `${match[2] ? "Nullable" : ""}${match[3]!.trim()}`,
    });
  }
  return entries;
}

export function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}
