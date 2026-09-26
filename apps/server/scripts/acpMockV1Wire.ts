// The translator rewrites opaque JSON-RPC lines between wire generations.
// @effect-diagnostics preferSchemaOverJson:off
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as AcpSchemaV1 from "effect-acp/schema-v1";

/**
 * ACP v1 profile for the mock agent (`T3_ACP_WIRE=v1`).
 *
 * The mock is written against ACP v2. Real Grok, cursor-agent and
 * Antigravity still speak the v1 message shape, so this rewrites the wire in
 * both directions: v1 requests from the client become the v2 requests the
 * mock handles, and the mock's v2 replies become v1. Every outgoing
 * `session/update` and setup reply is checked against the v1 schema, and the
 * mock exits loudly when a knob emits something v1 cannot carry.
 */
export interface AcpMockV1Wire {
  readonly wrapStdio: (stdio: Stdio.Stdio, onIncomingLine?: (line: string) => void) => Stdio.Stdio;
  /** Rewrites one outgoing v2 message into its v1 lines (possibly none). */
  readonly toClientLines: (message: unknown) => string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};

const idKey = (id: unknown) => JSON.stringify(id ?? null);

const v1Checks: Readonly<Record<string, (value: unknown) => unknown>> = {
  "session/update": Schema.decodeUnknownSync(AcpSchemaV1.SessionNotification),
  "session/request_permission": Schema.decodeUnknownSync(AcpSchemaV1.RequestPermissionRequest),
  initialize: Schema.decodeUnknownSync(AcpSchemaV1.InitializeResponse),
  "session/new": Schema.decodeUnknownSync(AcpSchemaV1.NewSessionResponse),
  "session/load": Schema.decodeUnknownSync(AcpSchemaV1.LoadSessionResponse),
  "session/resume": Schema.decodeUnknownSync(AcpSchemaV1.ResumeSessionResponse),
  "session/prompt": Schema.decodeUnknownSync(AcpSchemaV1.PromptResponse),
};

function checkV1<A extends JsonRecord>(method: string, message: A): A {
  try {
    v1Checks[method]?.(message.method === undefined ? message.result : message.params);
  } catch (cause) {
    process.stderr.write(`acp mock v1 wire cannot carry ${method}: ${String(cause)}\n`);
    process.exit(70);
  }
  return message;
}

const v1McpServers = (servers: unknown) =>
  Array.isArray(servers)
    ? servers.map((server) =>
        "type" in record(server) ? server : { type: "stdio", ...record(server) },
      )
    : servers;

const v1ConfigOptions = (options: unknown) =>
  Array.isArray(options)
    ? options.map((option) => {
        const { configId, ...rest } = record(option);
        return {
          ...rest,
          id: configId,
          ...(Array.isArray(rest.options)
            ? {
                options: rest.options.map((entry) => {
                  const { groupId, ...group } = record(entry);
                  return groupId === undefined ? entry : { ...group, group: groupId };
                }),
              }
            : {}),
        };
      })
    : options;

function v1Initialize(result: JsonRecord, protocolVersion: 1 | 2): JsonRecord {
  const session = record(result.capabilities).session;
  const prompt = record(record(session).prompt);
  const mcp = record(record(session).mcp);
  const authMethods = Array.isArray(result.authMethods) ? result.authMethods.map(record) : [];
  return {
    protocolVersion,
    ...(result.info === undefined ? {} : { agentInfo: result.info }),
    agentCapabilities: {
      loadSession: session != null,
      promptCapabilities: {
        image: prompt.image != null,
        audio: prompt.audio != null,
        embeddedContext: prompt.embeddedContext != null,
      },
      mcpCapabilities: { http: mcp.http != null, acp: mcp.acp != null },
      ...(session == null
        ? {}
        : {
            sessionCapabilities: {
              list: {},
              resume: {},
              close: {},
              ...(record(session).fork == null ? {} : { fork: {} }),
              ...(record(session).additionalDirectories == null
                ? {}
                : { additionalDirectories: {} }),
            },
          }),
      ...(authMethods.length === 0 ? {} : { auth: { logout: {} } }),
    },
    ...(authMethods.length === 0
      ? {}
      : {
          authMethods: authMethods.map(({ methodId, type: _type, ...method }) => ({
            ...method,
            id: methodId,
          })),
        }),
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
  };
}

export function makeAcpMockV1Wire(options: {
  /** Antigravity reports 2 while it still answers in the v1 shape. */
  readonly protocolVersion: 1 | 2;
  /** v1 setup replies carry the unstable `modes` and `models` fields. */
  readonly sessionState: () => JsonRecord;
}): AcpMockV1Wire {
  const clientRequests = new Map<
    string,
    { readonly method: string; readonly params: JsonRecord }
  >();
  const stopReasons = new Map<string, string>();
  const announcedToolCalls = new Set<string>();

  const toAgent = (message: JsonRecord): JsonRecord => {
    const method = message.method;
    if (typeof method !== "string") return message;
    const params = record(message.params);
    if (message.id !== undefined) clientRequests.set(idKey(message.id), { method, params });
    switch (method) {
      case "authenticate":
        return { ...message, method: "auth/login" };
      case "logout":
        return { ...message, method: "auth/logout" };
      case "session/new":
      case "session/resume":
      case "session/fork":
        return { ...message, params: { ...params, mcpServers: v1McpServers(params.mcpServers) } };
      case "session/load":
        return {
          ...message,
          method: "session/resume",
          params: {
            ...params,
            mcpServers: v1McpServers(params.mcpServers),
            replayFrom: { type: "start" },
          },
        };
      case "session/set_model":
      case "session/set_mode":
        return {
          ...message,
          method: "session/set_config_option",
          params: {
            sessionId: params.sessionId,
            configId: method === "session/set_model" ? "model" : "mode",
            type: "id",
            value: method === "session/set_model" ? params.modelId : params.modeId,
          },
        };
      case "session/set_config_option":
        return { ...message, params: { type: "id", ...params } };
      default:
        return message;
    }
  };

  const sessionUpdate = (sessionId: unknown, update: JsonRecord): ReadonlyArray<JsonRecord> => {
    switch (update.sessionUpdate) {
      case "state_update":
        // v1 has no turn state; the stop reason rides on the prompt reply.
        if (update.state === "idle" && typeof update.stopReason === "string") {
          stopReasons.set(String(sessionId), update.stopReason);
        }
        return [];
      case "tool_call":
      case "tool_call_update": {
        const key = `${String(sessionId)}\0${String(update.toolCallId)}`;
        if (announcedToolCalls.has(key)) return [update];
        announcedToolCalls.add(key);
        // v1 announces a tool call before it updates it.
        return [
          {
            ...update,
            sessionUpdate: "tool_call",
            title: update.title == null ? "" : update.title,
          },
        ];
      }
      case "plan_update": {
        const plan = record(update.plan);
        return plan.type === "items"
          ? [
              {
                sessionUpdate: "plan",
                entries: plan.entries,
                ...(update._meta === undefined ? {} : { _meta: update._meta }),
              },
            ]
          : [update];
      }
      case "config_option_update":
        return [{ ...update, configOptions: v1ConfigOptions(update.configOptions) }];
      case "available_commands_update":
        return [
          {
            ...update,
            availableCommands: Array.isArray(update.availableCommands)
              ? update.availableCommands.map((command) => {
                  const { input, ...rest } = record(command);
                  const hint = record(input).hint;
                  return typeof hint === "string" ? { ...rest, input: { hint } } : rest;
                })
              : update.availableCommands,
          },
        ];
      case "user_message":
      case "agent_message":
      case "agent_thought": {
        const { content, ...rest } = update;
        return (Array.isArray(content) ? content : []).map((block) => ({
          ...rest,
          sessionUpdate: `${String(update.sessionUpdate)}_chunk`,
          content: block,
        }));
      }
      default:
        return [update];
    }
  };

  const toClient = (message: JsonRecord): ReadonlyArray<JsonRecord> => {
    const method = message.method;
    const params = record(message.params);
    if (method === "session/update") {
      return sessionUpdate(params.sessionId, record(params.update)).map((update) =>
        checkV1(method, { ...message, params: { ...params, update } }),
      );
    }
    if (method === "session/request_permission") {
      const { title, description: _description, subject: rawSubject, ...rest } = params;
      const subject = record(rawSubject);
      const toolCall =
        subject.type === "tool_call"
          ? subject.toolCall
          : {
              toolCallId: subject.toolCallId ?? String(message.id),
              title,
              kind: subject.type === "command" ? "execute" : "other",
            };
      return [checkV1(method, { ...message, params: { ...rest, toolCall } })];
    }
    if (method !== undefined) return [message];

    const request = clientRequests.get(idKey(message.id));
    clientRequests.delete(idKey(message.id));
    if (request === undefined || message.error !== undefined) return [message];
    return [
      checkV1(request.method, { ...message, result: v1Result(request, record(message.result)) }),
    ];
  };

  const v1Result = (
    request: { readonly method: string; readonly params: JsonRecord },
    result: JsonRecord,
  ): JsonRecord => {
    switch (request.method) {
      case "initialize":
        return v1Initialize(result, options.protocolVersion);
      case "session/new":
      case "session/load":
      case "session/resume":
      case "session/fork":
        return {
          ...result,
          ...options.sessionState(),
          configOptions: v1ConfigOptions(result.configOptions),
        };
      case "session/set_model":
      case "session/set_mode":
        return {};
      case "session/set_config_option":
        return { configOptions: v1ConfigOptions(result.configOptions) };
      case "session/prompt": {
        const sessionId = String(request.params.sessionId);
        const stopReason = stopReasons.get(sessionId) ?? "end_turn";
        stopReasons.delete(sessionId);
        return { ...result, stopReason };
      }
      default:
        return result;
    }
  };

  const translateLines = (
    text: string,
    translate: (message: JsonRecord) => ReadonlyArray<JsonRecord>,
  ): string =>
    text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return `${line}\n`;
        }
        return translate(record(parsed))
          .map((message) => `${JSON.stringify(message)}\n`)
          .join("");
      })
      .join("");

  const toClientLines = (message: unknown) => translateLines(JSON.stringify(message), toClient);

  return {
    toClientLines,
    wrapStdio: (stdio, onIncomingLine) => {
      const decoder = new TextDecoder();
      let pendingOutput = "";
      return Stdio.make({
        args: stdio.args,
        stderr: stdio.stderr,
        stdin: stdio.stdin.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map((line) => {
            onIncomingLine?.(line);
            return translateLines(line, (message) => [toAgent(message)]);
          }),
          Stream.encodeText,
        ),
        stdout: (stdoutOptions) =>
          Sink.mapInput(stdio.stdout(stdoutOptions), (chunk: string | Uint8Array) => {
            const text =
              pendingOutput +
              (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
            const end = text.lastIndexOf("\n") + 1;
            pendingOutput = text.slice(end);
            return translateLines(text.slice(0, end), toClient);
          }),
      });
    },
  };
}
