// Fork: Kaluwa's Extensions page. Maps Codex's `codex mcp` CLI to Extensions shapes.
import type {
  ExtensionHealth,
  ExtensionMcpServer,
  ExtensionMcpServerSpec,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { redactCommandLine, redactUrl } from "./redaction.ts";

// Plugins and apps add MCP servers of their own; the page lists only the user's config.toml ones.
export const CODEX_USER_CONFIG_ONLY_ARGS = [
  "--config",
  "features.connectors=false",
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;

const StringRecord = Schema.Record(Schema.String, Schema.String);

const CodexTransport = Schema.Struct({
  type: Schema.String,
  command: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  env: Schema.optional(Schema.NullOr(StringRecord)),
  env_vars: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  bearer_token_env_var: Schema.optional(Schema.NullOr(Schema.String)),
  http_headers: Schema.optional(Schema.NullOr(StringRecord)),
  env_http_headers: Schema.optional(Schema.NullOr(StringRecord)),
});

const CodexMcpServer = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  disabled_reason: Schema.optional(Schema.NullOr(Schema.String)),
  transport: CodexTransport,
  auth_status: Schema.optional(Schema.NullOr(Schema.String)),
});
type CodexMcpServer = typeof CodexMcpServer.Type;

const decodeCodexMcpList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodeCodexMcpServer = Schema.decodeUnknownOption(CodexMcpServer);
const decodeCodexMcpGet = Schema.decodeUnknownOption(Schema.fromJsonString(CodexMcpServer));

function codexHealth(server: CodexMcpServer, hasStaticAuth: boolean) {
  if (!server.enabled) {
    return { health: "disabled" as ExtensionHealth, detail: server.disabled_reason ?? null };
  }
  // `codex mcp list` never connects, so this reflects configuration and sign-in only.
  switch (server.auth_status ?? "unsupported") {
    case "unsupported":
    case "bearer_token":
    case "o_auth":
      return { health: "ok" as ExtensionHealth, detail: null };
    case "not_logged_in":
      return hasStaticAuth
        ? { health: "ok" as ExtensionHealth, detail: null }
        : { health: "needsAuth" as ExtensionHealth, detail: "Not signed in" };
    default:
      return { health: "unknown" as ExtensionHealth, detail: server.auth_status ?? null };
  }
}

function mapCodexServer(server: CodexMcpServer): ExtensionMcpServer | undefined {
  const transport = server.transport;
  if (transport.type === "stdio" && transport.command) {
    return {
      name: server.name,
      transport: "stdio",
      target: redactCommandLine(transport.command, transport.args ?? []),
      secretNames: [...Object.keys(transport.env ?? {}), ...(transport.env_vars ?? [])],
      enabled: server.enabled,
      ...codexHealth(server, false),
      managedElsewhere: false,
    };
  }
  if (transport.type === "streamable_http" && transport.url) {
    const secretNames = [
      ...Object.keys(transport.http_headers ?? {}),
      ...Object.keys(transport.env_http_headers ?? {}),
      ...(transport.bearer_token_env_var ? [transport.bearer_token_env_var] : []),
    ];
    return {
      name: server.name,
      transport: "http",
      target: redactUrl(transport.url),
      secretNames,
      enabled: server.enabled,
      ...codexHealth(server, secretNames.length > 0),
      managedElsewhere: false,
    };
  }
  return undefined;
}

/** Maps `codex mcp list --json`; `undefined` when the output isn't that JSON. */
export function parseCodexMcpList(output: string): ReadonlyArray<ExtensionMcpServer> | undefined {
  const rows = decodeCodexMcpList(output);
  if (Option.isNone(rows)) return undefined;
  return rows.value.flatMap((row) =>
    Option.match(decodeCodexMcpServer(row), {
      onNone: () => [],
      onSome: (server) => mapCodexServer(server) ?? [],
    }),
  );
}

export interface CopiedSpec {
  readonly spec: ExtensionMcpServerSpec;
  /** What the copy can't carry, by name only. */
  readonly notCopied: ReadonlyArray<string>;
}

/** Reads a full server from `codex mcp get <name> --json`, which includes secret values. */
export function codexSpecFromGet(output: string): CopiedSpec | undefined {
  const server = decodeCodexMcpGet(output);
  if (Option.isNone(server)) return undefined;
  const transport = server.value.transport;
  if (transport.type === "stdio" && transport.command) {
    return {
      spec: {
        _tag: "stdio",
        command: transport.command,
        args: transport.args ?? [],
        env: transport.env ?? {},
      },
      notCopied: (transport.env_vars ?? []).map((name) => `forwarded env var ${name}`),
    };
  }
  if (transport.type === "streamable_http" && transport.url) {
    return {
      spec: {
        _tag: "remote",
        transport: "http",
        url: transport.url,
        headers: transport.http_headers ?? {},
      },
      notCopied: [
        ...Object.keys(transport.env_http_headers ?? {}).map((name) => `header ${name}`),
        ...(transport.bearer_token_env_var
          ? [`bearer token from ${transport.bearer_token_env_var}`]
          : []),
      ],
    };
  }
  return undefined;
}

export type CodexAddPlan =
  | {
      readonly _tag: "run";
      readonly args: ReadonlyArray<string>;
      readonly notSet: ReadonlyArray<string>;
    }
  | { readonly _tag: "unsupported"; readonly message: string };

/**
 * `codex mcp add` has no stdin form, so stdio env values go in argv; it can't store HTTP headers at all.
 * A copy with headers is added without them, and the outcome names the headers to set by hand.
 */
export function codexAddPlan(name: string, spec: ExtensionMcpServerSpec): CodexAddPlan {
  if (spec._tag === "stdio") {
    return {
      _tag: "run",
      args: [
        "mcp",
        "add",
        ...Object.entries(spec.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        name,
        "--",
        spec.command,
        ...spec.args,
      ],
      notSet: [],
    };
  }
  if (spec.transport === "sse") {
    return {
      _tag: "unsupported",
      message: "Codex supports only stdio and streamable HTTP servers.",
    };
  }
  return {
    _tag: "run",
    args: ["mcp", "add", name, "--url", spec.url],
    notSet: Object.keys(spec.headers).map((header) => `header ${header}`),
  };
}
