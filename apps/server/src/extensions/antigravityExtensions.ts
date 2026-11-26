// Fork: Kaluwa's Extensions page. Antigravity's MCP servers live in each instance's private
// GEMINI_HOME (`config/mcp_config.json`, key `mcpServers`). `agy mcp` ignores GEMINI_HOME and edits
// the real ~/.gemini, so this file is read and written directly, keeping every key it doesn't own.
import type { ExtensionMcpServer, ExtensionMcpServerSpec } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { mcpServerFromSpec } from "./claudeExtensions.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const decodeObject = Schema.decodeUnknownOption(JsonObject);

const StringRecord = Schema.Record(Schema.String, Schema.String);
const AntigravityMcpEntry = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringRecord),
  serverUrl: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  httpUrl: Schema.optional(Schema.String),
  headers: Schema.optional(StringRecord),
  disabled: Schema.optional(Schema.Boolean),
});
const decodeAntigravityMcpEntry = Schema.decodeUnknownOption(AntigravityMcpEntry);

const UNPARSEABLE_CONFIG = "mcp_config.json is not a JSON object, so it was left unchanged.";

type JsonObject = Record<string, unknown>;

// The CLI writes a 0-byte file before any server exists.
function parseConfig(text: string): JsonObject | undefined {
  if (text.trim().length === 0) return {};
  return Option.getOrUndefined(decodeJsonObject(text));
}

function serversOf(config: JsonObject): JsonObject {
  return Option.getOrElse(decodeObject(config.mcpServers), () => ({}));
}

function antigravitySpecOf(raw: unknown): ExtensionMcpServerSpec | undefined {
  const entry = Option.getOrUndefined(decodeAntigravityMcpEntry(raw));
  if (entry === undefined) return undefined;
  if (entry.command) {
    return { _tag: "stdio", command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
  }
  const url = entry.serverUrl ?? entry.httpUrl ?? entry.url;
  return url ? { _tag: "remote", transport: "http", url, headers: entry.headers ?? {} } : undefined;
}

export interface AntigravityMcpServers {
  readonly servers: ReadonlyArray<ExtensionMcpServer>;
  readonly specs: ReadonlyMap<string, ExtensionMcpServerSpec>;
}

export function readAntigravityMcpServers(text: string): AntigravityMcpServers | undefined {
  const config = parseConfig(text);
  if (config === undefined) return undefined;
  const servers: Array<ExtensionMcpServer> = [];
  const specs = new Map<string, ExtensionMcpServerSpec>();
  for (const [name, raw] of Object.entries(serversOf(config))) {
    const spec = antigravitySpecOf(raw);
    if (spec === undefined || name.trim().length === 0) continue;
    const disabled = Option.match(decodeAntigravityMcpEntry(raw), {
      onNone: () => false,
      onSome: (entry) => entry.disabled === true,
    });
    specs.set(name, spec);
    servers.push(
      mcpServerFromSpec(name, spec, {
        enabled: !disabled,
        health: disabled ? "disabled" : "unknown",
      }),
    );
  }
  return { servers, specs };
}

function entryOf(spec: ExtensionMcpServerSpec): JsonObject {
  return spec._tag === "stdio"
    ? { command: spec.command, args: spec.args, env: spec.env, disabled: false }
    : { serverUrl: spec.url, headers: spec.headers, disabled: false };
}

function encode(config: JsonObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

type Edit =
  | { readonly _tag: "add"; readonly name: string; readonly spec: ExtensionMcpServerSpec }
  | { readonly _tag: "remove"; readonly name: string }
  | { readonly _tag: "setEnabled"; readonly name: string; readonly enabled: boolean };

export type AntigravityEditResult =
  | { readonly _tag: "changed"; readonly text: string }
  | { readonly _tag: "refused"; readonly message: string };

/** Applies one edit to the file's text. Other servers' entries and other top-level keys stay as they were. */
export function editAntigravityMcpConfig(text: string, edit: Edit): AntigravityEditResult {
  const config = parseConfig(text);
  if (config === undefined) {
    return { _tag: "refused", message: UNPARSEABLE_CONFIG };
  }
  const servers = serversOf(config);
  const existing = servers[edit.name];
  switch (edit._tag) {
    case "add": {
      if (existing !== undefined) {
        return { _tag: "refused", message: `A server named "${edit.name}" already exists.` };
      }
      if (edit.spec._tag === "remote" && edit.spec.transport === "sse") {
        return { _tag: "refused", message: "Antigravity supports only stdio and HTTP servers." };
      }
      return {
        _tag: "changed",
        text: encode({ ...config, mcpServers: { ...servers, [edit.name]: entryOf(edit.spec) } }),
      };
    }
    case "remove": {
      if (existing === undefined) {
        return { _tag: "refused", message: `No server named "${edit.name}".` };
      }
      const { [edit.name]: _removed, ...rest } = servers;
      return { _tag: "changed", text: encode({ ...config, mcpServers: rest }) };
    }
    case "setEnabled": {
      const entry = decodeObject(existing);
      if (Option.isNone(entry)) {
        return { _tag: "refused", message: `No server named "${edit.name}".` };
      }
      return {
        _tag: "changed",
        text: encode({
          ...config,
          mcpServers: { ...servers, [edit.name]: { ...entry.value, disabled: !edit.enabled } },
        }),
      };
    }
  }
}
