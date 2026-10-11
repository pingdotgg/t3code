/**
 * A Settings → Tools server's tools, read by starting the server the way an
 * agent session would: the same settings, project overrides and secrets, then
 * `initialize` and `tools/list`, then shut down. T3's own `t3-code` server is
 * read from its toolkits without starting anything.
 */
import {
  type McpServerTool,
  type McpServerToolParameter,
  McpServerToolsError,
  type McpServerToolsInput,
  type McpServerToolsResult,
  type McpServerTransport,
  mcpServerVariableRecord,
  type ServerSettingsError,
  T3_MCP_SERVER_NAME,
} from "@t3tools/contracts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";

import { T3_MCP_TOOLKITS } from "../mcp/McpHttpServer.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Long enough for `npx -y` to fetch a package on a first run. */
const LIST_TOOLS_TIMEOUT = Duration.seconds(30);
/** A server that pages forever stops being read here. */
const MAX_TOOL_PAGES = 50;

export class McpServerTools extends Context.Service<
  McpServerTools,
  {
    /** The named server's tools, as an agent in the project at `cwd` (or on the environment) gets it. */
    readonly listTools: (
      input: McpServerToolsInput,
    ) => Effect.Effect<McpServerToolsResult, McpServerToolsError | ServerSettingsError>;
  }
>()("t3/mcpServers/McpServerTools") {}

// ── Tool descriptions ────────────────────────────────────────────────

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** A short reading of a JSON Schema's type: `string`, `number[]`, `"a" | "b"`, `object`. */
function schemaTypeLabel(schema: unknown, depth = 0): string | undefined {
  if (!isObject(schema) || depth > 3) return undefined;
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const shown = schema.enum.slice(0, 6).map((value) => JSON.stringify(value));
    return schema.enum.length > shown.length ? `${shown.join(" | ")} | …` : shown.join(" | ");
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === "string");
    return names.length === 0 ? undefined : names.join(" | ");
  }
  if (type === "array") {
    const item = schemaTypeLabel(schema.items, depth + 1);
    return item === undefined ? "array" : item.includes(" ") ? `(${item})[]` : `${item}[]`;
  }
  if (typeof type === "string") return type;
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options)) continue;
    const labels = [
      ...new Set(
        options
          .map((option) => schemaTypeLabel(option, depth + 1))
          .filter((label): label is string => label !== undefined),
      ),
    ];
    if (labels.length > 0) return labels.join(" | ");
  }
  return isObject(schema.properties) ? "object" : undefined;
}

/** The top-level properties of a tool's input schema, required ones first. */
function summarizeToolParameters(inputSchema: unknown): ReadonlyArray<McpServerToolParameter> {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return [];
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const parameters = Object.entries(inputSchema.properties).map(([name, schema]) => {
    const type = schemaTypeLabel(schema);
    const description = isObject(schema) ? nonEmpty(schema.description) : undefined;
    return {
      name,
      required: required.has(name),
      ...(type === undefined ? {} : { type }),
      ...(description === undefined ? {} : { description }),
    } satisfies McpServerToolParameter;
  });
  // A stable sort, so each half keeps the server's order.
  return parameters.toSorted((left, right) => Number(right.required) - Number(left.required));
}

function describeTool(tool: {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly annotations?: { readonly title?: string | undefined } | undefined;
  readonly inputSchema?: unknown;
}): McpServerTool {
  const title = nonEmpty(tool.title) ?? nonEmpty(tool.annotations?.title);
  const description = nonEmpty(tool.description);
  return {
    name: tool.name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    parameters: summarizeToolParameters(tool.inputSchema),
  };
}

/**
 * T3's own tools, from the toolkits `/mcp` registers. A session only gets the
 * ones its access allows (browser and device tools follow their settings), but
 * every one is listed here.
 */
function t3CodeTools(): McpServerToolsResult {
  const tools = new Map<string, McpServerTool>();
  for (const toolkit of T3_MCP_TOOLKITS) {
    for (const tool of Object.values(toolkit.tools)) {
      if (tools.has(tool.name)) continue;
      tools.set(
        tool.name,
        describeTool({
          name: tool.name,
          title: Option.getOrUndefined(Context.getOption(tool.annotations, Tool.Title)),
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
        }),
      );
    }
  }
  return {
    serverInfo: { name: "T3 Code" },
    tools: [...tools.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

// ── Talking to a server ──────────────────────────────────────────────

/** Loaded on first use, so the server doesn't load the MCP client and its validators at startup. */
const loadSdk = () =>
  Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
    import("@modelcontextprotocol/sdk/client/auth.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]).then(([client, stdio, streamableHttp, sse, auth, types]) => ({
    Client: client.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    StreamableHTTPClientTransport: streamableHttp.StreamableHTTPClientTransport,
    StreamableHTTPError: streamableHttp.StreamableHTTPError,
    SSEClientTransport: sse.SSEClientTransport,
    SseError: sse.SseError,
    UnauthorizedError: auth.UnauthorizedError,
    McpError: types.McpError,
    connectionClosed: types.ErrorCode.ConnectionClosed,
  }));
type Sdk = Awaited<ReturnType<typeof loadSdk>>;

/** Why a server couldn't be listed, from what the SDK and Node throw. */
function failureReason(
  sdk: Sdk,
  transport: McpServerTransport,
  cause: unknown,
  stage: "connect" | "list",
): McpServerToolsError["reason"] {
  const gone = transport.type === "stdio" ? "exited" : "unreachable";
  if (cause instanceof sdk.UnauthorizedError) return "unauthorized";
  if (cause instanceof sdk.McpError) {
    // The SDK's own code for a process or socket that went away.
    return cause.code === sdk.connectionClosed ? gone : "request-failed";
  }
  if (cause instanceof sdk.StreamableHTTPError || cause instanceof sdk.SseError) {
    const status = cause.code;
    if (status === 401 || status === 403) return "unauthorized";
    return typeof status === "number" && status >= 400 && status < 500 ? "request-failed" : gone;
  }
  // Node's spawn error (ENOENT, EACCES) rejects the transport's start.
  if (transport.type === "stdio" && stage === "connect") return "spawn-failed";
  return gone;
}

/** A 404 or 405 for the first POST: an older server that only speaks SSE. */
const wantsSseFallback = (sdk: Sdk, cause: unknown) =>
  cause instanceof sdk.StreamableHTTPError && (cause.code === 404 || cause.code === 405);

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  let t3CodeListing: McpServerToolsResult | undefined;

  /** The server as agents in this scope get it: project overrides applied, secrets filled in. */
  const resolveServer = Effect.fn("McpServerTools.resolveServer")(function* (
    input: McpServerToolsInput,
  ) {
    let projectId = null;
    let cwd: string | undefined;
    if (input.cwd !== undefined) {
      const project = yield* projects.getByWorkspaceRoot(input.cwd).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project === undefined) {
        return yield* new McpServerToolsError({ server: input.name, reason: "unknown-project" });
      }
      projectId = project.id;
      cwd = project.workspaceRoot;
    }
    const settings = yield* settingsService.getSettings;
    const servers = resolveProjectSettings(settings, projectId).settings.mcpServers;
    const server = Object.hasOwn(servers, input.name) ? servers[input.name] : undefined;
    if (server === undefined) {
      return yield* new McpServerToolsError({ server: input.name, reason: "not-found" });
    }
    // A server switched off is still inspected: its definition is what's asked about.
    return { transport: server.transport, cwd };
  });

  const listServerTools = Effect.fn("McpServerTools.listServerTools")(function* (
    name: string,
    transport: McpServerTransport,
    cwd: string | undefined,
  ) {
    yield* Effect.annotateCurrentSpan({ "mcp.server.transport": transport.type });
    const hostEnvironment = yield* HostProcess.Environment;
    const sdk = yield* Effect.promise(loadSdk);
    const fail = (reason: McpServerToolsError["reason"], cause?: unknown) =>
      new McpServerToolsError({ server: name, reason, ...(cause === undefined ? {} : { cause }) });

    const makeTransport = (kind: "streamable" | "sse") => {
      if (transport.type === "stdio") {
        // The host environment with the server's variables over it, as providers
        // start their servers; the SDK's default would keep only a few names.
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(hostEnvironment)) {
          if (value !== undefined) env[key] = value;
        }
        return new sdk.StdioClientTransport({
          command: transport.command,
          args: [...transport.args],
          env: { ...env, ...mcpServerVariableRecord(transport.env) },
          // A project's agents run in its checkout, where a relative path resolves.
          ...(cwd === undefined ? {} : { cwd }),
          stderr: "ignore",
        });
      }
      const url = new URL(transport.url);
      const requestInit = { headers: mcpServerVariableRecord(transport.headers) };
      return kind === "sse"
        ? new sdk.SSEClientTransport(url, { requestInit })
        : new sdk.StreamableHTTPClientTransport(url, { requestInit });
    };

    /** Connects and initializes; the client and its process close with the scope. */
    const connect = (kind: "streamable" | "sse") =>
      Effect.acquireRelease(
        Effect.sync(() => ({
          client: new sdk.Client({ name: "t3-code", version: "1.0.0" }, { capabilities: {} }),
          connection: makeTransport(kind),
        })),
        // Closing a stdio transport ends stdin, then sends SIGTERM and SIGKILL
        // until the process has exited, and resolves only once it has.
        ({ client, connection }) =>
          Effect.promise(() => client.close().then(() => connection.close())).pipe(Effect.ignore),
      ).pipe(
        Effect.tap(({ client, connection }) =>
          Effect.tryPromise({
            // The SDK declares `sessionId?: string`, which its own HTTP transport's
            // `string | undefined` getter misses under exactOptionalPropertyTypes.
            try: () => client.connect(connection as Transport),
            catch: (cause) => fail(failureReason(sdk, transport, cause, "connect"), cause),
          }),
        ),
      );

    const listPages = (client: InstanceType<Sdk["Client"]>) =>
      Effect.gen(function* () {
        const tools: McpServerTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
          const result = yield* Effect.tryPromise({
            try: () => client.listTools(cursor === undefined ? undefined : { cursor }),
            catch: (cause) => fail(failureReason(sdk, transport, cause, "list"), cause),
          });
          tools.push(...result.tools.map(describeTool));
          cursor = result.nextCursor;
          if (cursor === undefined) break;
        }
        return tools;
      });

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* connect("streamable").pipe(
          Effect.catchIf(
            (error) => transport.type === "http" && wantsSseFallback(sdk, error.cause),
            () => connect("sse"),
          ),
        );
        const tools = yield* listPages(client);
        const info = client.getServerVersion();
        const serverName = nonEmpty(info?.name);
        const version = nonEmpty(info?.version);
        return {
          ...(serverName === undefined
            ? {}
            : { serverInfo: { name: serverName, ...(version === undefined ? {} : { version }) } }),
          tools,
        } satisfies McpServerToolsResult;
      }),
    ).pipe(
      // The timeout interrupts the scope, which still waits for the process to exit.
      Effect.timeoutOrElse({
        duration: LIST_TOOLS_TIMEOUT,
        orElse: () => Effect.fail(fail("timed-out")),
      }),
    );
  });

  const listTools: McpServerTools["Service"]["listTools"] = Effect.fn("McpServerTools.listTools")(
    function* (input) {
      if (input.name === T3_MCP_SERVER_NAME) {
        t3CodeListing ??= t3CodeTools();
        return t3CodeListing;
      }
      const server = yield* resolveServer(input);
      return yield* listServerTools(input.name, server.transport, server.cwd);
    },
  );

  return McpServerTools.of({ listTools });
});

export const layer = Layer.effect(McpServerTools, make);
