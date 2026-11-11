import { withinModes } from "@t3tools/client-runtime/gateway";
import { GatewayError } from "@t3tools/mcp-gateway";
import {
  failure,
  GATEWAY_ONLY_TOOLS,
  requestContext,
  requiresEnvironment,
  runGatewayTool,
  SERVER_SUPERSEDED_TOOLS,
  success,
  TOOL_SPECS,
  toolInputJsonSchema,
  type ToolSpec,
} from "@t3tools/mcp-gateway/catalog";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTaskService from "../../threadTask/ThreadTaskService.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { loadCaller } from "../threadAccess.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";
import { assignRemoteChild, gatewayToolContext } from "./remoteThreads.ts";

type ToolResult = {
  readonly isError?: boolean;
  readonly content: unknown;
  readonly structuredContent: unknown;
};

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Gateway envelopes can hold `undefined` fields, which MCP's JSON schema rejects, so structured
// content goes through JSON. The text block is a compacted copy for the model, not the same body.
const toCallToolResult = (result: ToolResult) =>
  new McpSchema.CallToolResult({
    isError: result.isError === true,
    structuredContent: decodeJsonText(JSON.stringify(result.structuredContent)) as Record<
      string,
      unknown
    >,
    content: result.content as McpSchema.CallToolResult["content"],
  });

/** Tools that create a chat; a named child they create on another machine gets its task here. */
const CREATE_TOOLS: ReadonlySet<string> = new Set([
  "t3_create_thread",
  "t3_create_and_start_thread",
]);

/** Tools that deliver text to another chat; managed workers report through their task instead. */
const MESSAGE_TOOLS: ReadonlySet<string> = new Set(["t3_send_message", "t3_answer_question"]);

/** Gateway tools that only read. Every other tool changes something and is declared a write. */
const READ_TOOL = /^t3_(?:list|get|summarize)_|^t3_(?:git_status|task_read|task_watch|task_board)$/;

const specOf = (name: string) => (TOOL_SPECS as Record<string, ToolSpec>)[name]!;

const AGENTS_TOOL_NAMES = Object.keys(TOOL_SPECS).filter(
  (name) => !GATEWAY_ONLY_TOOLS.has(name) && !SERVER_SUPERSEDED_TOOLS.has(name),
);

// The gateway validates arguments against the catalog's own schema (agentsToolInputSchema),
// so the toolkit passes the object through.
const agentsTool = (name: string) =>
  Tool.make(name, {
    description: specOf(name)[0],
    parameters: Schema.Record(Schema.String, Schema.Unknown),
    success: Schema.instanceOf(McpSchema.CallToolResult),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  });

/** The T3 Agents tools this server's `t3-code` MCP hosts: every one that needs no event store. */
export const AgentsToolkit = Toolkit.make(...AGENTS_TOOL_NAMES.map(agentsTool));

/** The catalog's input schema; a tool's environmentId defaults to this server's own. */
export const agentsToolInputSchema = (name: string) =>
  toolInputJsonSchema(name, { environmentDefault: true }) as McpSchema.Tool["inputSchema"];

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

/** How a call refused before reaching the gateway reads to the agent: a gateway failure. */
export const agentsToolRefusal = (error: unknown, args: Record<string, unknown>) =>
  toCallToolResult(
    failure(
      isOrchestratorMcpFailure(error)
        ? new GatewayError({ code: "scope_required", message: error.message, retryable: false })
        : error,
      requestContext(args),
    ),
  );

const modeRefusal = (message: string) =>
  new GatewayError({ code: "scope_required", message, retryable: false });

/** Whether this server hosts the Agents tools; servers without the in-process port host none. */
export const hostsAgentsTools = Effect.map(Effect.serviceOption(LocalGatewayPort), Option.isSome);

/** The tools' handlers, each declaring who may call it (see McpToolAccess). */
export const layer = McpToolAccess.toLayer(
  AgentsToolkit,
  Effect.gen(function* () {
    const tasks = Option.getOrUndefined(
      yield* Effect.serviceOption(ThreadTaskService.ThreadTaskService),
    );
    const local = yield* gatewayToolContext;
    const context = local?.context;

    const handle = (name: string) => {
      const defaultEnvironment = requiresEnvironment(name);
      return (payload: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* () {
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const args = { ...payload };
          if (local === undefined || context === undefined) {
            return toCallToolResult(
              failure(new Error("This server hosts no T3 Agents tools."), requestContext(args)),
            );
          }
          if (defaultEnvironment && typeof args.environmentId !== "string") {
            args.environmentId = local.environmentId;
          }
          if (!invocation.capabilities.has("orchestration")) {
            return toCallToolResult(
              failure(
                new Error("This chat's MCP credential cannot use T3 Agents tools."),
                requestContext(args),
              ),
            );
          }
          // An OAuth client has no calling thread; the gateway then needs explicit targets.
          const caller =
            invocation.thread === undefined
              ? undefined
              : { environmentId: local.environmentId, threadId: invocation.thread.threadId };
          // A relayed call runs there as the app's user, and a local one as this server's own
          // client, so neither end sees the calling chat's modes; they are enforced here.
          // Refused here first; the app answering a relayed call applies the same limits to the
          // target as it reads it, since this server only sees what that app reports.
          const limits = READ_TOOL.test(name) ? undefined : (yield* loadCaller()).limits;
          const relayed = limits === undefined ? context : local.contextFor(limits);
          const toolContext =
            limits === undefined
              ? relayed
              : { ...relayed, port: withinModes(relayed.port, limits, modeRefusal) };
          const run = Effect.promise(() =>
            runGatewayTool(toolContext, name, args, { caller }),
          ).pipe(
            Effect.flatMap((run) => {
              const created = run.ok ? (run.value as { threadId?: unknown }) : undefined;
              const isNamedRemoteChild =
                caller !== undefined &&
                created !== undefined &&
                CREATE_TOOLS.has(name) &&
                typeof created.threadId === "string" &&
                args.environmentId !== local.environmentId &&
                args.parentThreadId === undefined &&
                (typeof args.profileId === "string" || typeof args.profile === "string");
              if (!isNamedRemoteChild) return Effect.succeed(toCallToolResult(run.result));
              return assignRemoteChild({
                ownerThreadId: ThreadId.make(caller.threadId),
                workerThreadId: ThreadId.make(created.threadId as string),
                workerEnvironmentId: EnvironmentId.make(String(args.environmentId)),
                summary: String(args.title ?? created.threadId),
              }).pipe(
                Effect.map((taskWarning) =>
                  toCallToolResult(
                    taskWarning === undefined
                      ? run.result
                      : success({ ...created, taskWarning }, args),
                  ),
                ),
              );
            }),
          );
          // Task tools stay with this server as the calling chat (see createRoutedGatewayPort).
          if (caller === undefined || !MESSAGE_TOOLS.has(name) || tasks === undefined) {
            return yield* run;
          }
          // A worker on another environment cannot be messaging its own child.
          const targetThreadId =
            args.environmentId === local.environmentId && typeof args.threadId === "string"
              ? ThreadId.make(args.threadId)
              : null;
          return yield* tasks
            .authorizeMessage({ senderThreadId: ThreadId.make(caller.threadId), targetThreadId })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.succeed(
                    toCallToolResult(
                      failure(
                        new GatewayError({
                          code: "scope_required",
                          message: error.detail,
                          retryable: false,
                        }),
                        requestContext(args),
                      ),
                    ),
                  ),
                onSuccess: () => run,
              }),
            );
        });
    };

    return Object.fromEntries(
      AGENTS_TOOL_NAMES.map((name) => [
        name,
        READ_TOOL.test(name)
          ? McpToolAccess.reads(handle(name))
          : McpToolAccess.writes(handle(name)),
      ]),
    );
  }),
);
