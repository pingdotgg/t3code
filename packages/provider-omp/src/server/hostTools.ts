import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { mcpToolSession } from "@t3tools/shared/mcpToolSession";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { array, openOmpRpc, record, string } from "./rpc.ts";

const listHostTools = (value: ReadonlyArray<unknown>) =>
  value.flatMap((item) => {
    const tool = record(item);
    const name = string(tool.name);
    if (!name || !/^[\w-]+$/u.test(name)) return [];
    return [
      {
        name,
        description: string(tool.description)?.trim() || name,
        parameters: record(tool.inputSchema),
        // T3 has already deferred its larger catalog behind tool_search.
        loadMode: "essential",
      },
    ];
  });

export const makeOmpHostTools = Effect.fn("OmpAdapter.hostTools")(function* (
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  rpc: Effect.Success<ReturnType<typeof openOmpRpc>>,
  sessions: McpProviderSessions["Service"],
) {
  const scope = yield* Scope.Scope;
  const calls = new Map<string, Fiber.Fiber<void, never>>();
  let registered: string | undefined;
  let names = new Set<string>();
  const readConfig = () =>
    sessions
      .read(threadId)
      .pipe(
        Effect.map((config) => (config?.providerInstanceId === instanceId ? config : undefined)),
      );
  const openMcp = (config: NonNullable<Effect.Success<ReturnType<typeof sessions.read>>>) =>
    mcpToolSession({
      endpoint: config.endpoint,
      authorization: config.authorizationHeader,
      clientName: "t3-code-omp",
      exposure: "deferred",
    });
  const refresh = Effect.fnUntraced(function* () {
    const config = yield* readConfig();
    if (config?.providerSessionId === registered) return;
    names = new Set();
    const tools =
      config === undefined
        ? []
        : yield* openMcp(config).pipe(
            Effect.flatMap((mcp) => mcp.listTools()),
            Effect.scoped,
            Effect.timeout("5 seconds"),
            Effect.map(listHostTools),
            Effect.orElseSucceed(() => undefined),
          );
    if (tools === undefined) return;
    const installed = yield* rpc.request({ type: "set_host_tools", tools }).pipe(
      Effect.map((result) =>
        array(record(result).toolNames).filter((name): name is string => typeof name === "string"),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (installed === undefined) return;
    registered = config?.providerSessionId;
    names = new Set(installed);
  });

  const onFrame = Effect.fnUntraced(function* (
    frame: Record<string, unknown>,
    turnActive: boolean,
  ) {
    if (frame.type === "host_tool_cancel") {
      const targetId = string(frame.targetId);
      const call = targetId && calls.get(targetId);
      if (call) yield* Effect.forkIn(Fiber.interrupt(call), scope);
      return;
    }
    const requestId = string(frame.id);
    const name = string(frame.toolName);
    if (!requestId || calls.has(requestId)) return;
    const call = Effect.gen(function* () {
      const config = yield* readConfig();
      const result =
        turnActive && name && names.has(name) && config && config.providerSessionId === registered
          ? yield* openMcp(config).pipe(
              Effect.flatMap((mcp) => mcp.call(name, record(frame.arguments))),
              Effect.scoped,
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
      const response = record(result);
      const content = array(response.content).filter((block) => {
        const item = record(block);
        return (
          (item.type === "text" && typeof item.text === "string") ||
          (item.type === "image" &&
            typeof item.data === "string" &&
            typeof item.mimeType === "string")
        );
      });
      const isError = result === undefined || response.isError === true;
      yield* rpc
        .send({
          type: "host_tool_result",
          id: requestId,
          result: {
            content:
              result === undefined
                ? [
                    {
                      type: "text",
                      text: "This T3 Code tool is unavailable for the current thread.",
                    },
                  ]
                : content,
            ...(response.structuredContent === undefined
              ? {}
              : { details: response.structuredContent }),
            isError,
          },
          isError,
        })
        .pipe(Effect.ignore);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          calls.delete(requestId);
        }),
      ),
    );
    calls.set(requestId, yield* Effect.forkIn(call, scope));
  });
  return { refresh, onFrame };
});
