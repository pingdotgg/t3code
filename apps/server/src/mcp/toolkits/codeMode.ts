import {
  CodeModeExecInput,
  CodeModeWaitInput,
  CodeModeCancelInput,
  CodeModeExecutionResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/unstable/ai";

import { CodeModeService } from "../CodeModeService.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import { McpSessionRegistry } from "../McpSessionRegistry.ts";
import { readCaller, readMutationCaller } from "../threadAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";

const callable = Toolkit.merge(OrchestratorToolkit, ThreadToolkit);
type CallableTool = (typeof callable.tools)[keyof typeof callable.tools];
type DispatchServices = Exclude<Tool.HandlerServices<CallableTool>, McpInvocationContext>;

class CodeModeDispatch extends Context.Service<
  CodeModeDispatch,
  {
    invoke: (
      scope: McpInvocationContext["Service"],
      runId: string | null,
      name: string,
      args: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>;
  }
>()("t3/mcp/toolkits/codeMode/CodeModeDispatch") {}

export const CodeModeDispatchLive = Layer.effect(
  CodeModeDispatch,
  Effect.gen(function* () {
    const built = yield* callable;
    const context = yield* Effect.context<DispatchServices>();
    const host = yield* CodeModeService;
    const threads = yield* ThreadManagementService;
    yield* Stream.runForEach(threads.streamStoredEvents, (stored) => {
      const event = stored.event;
      if (
        event.type === "run.updated" &&
        ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
          event.payload.status,
        )
      ) {
        return Effect.sync(() => host.invalidateRun(event.threadId, event.payload.id));
      }
      if (
        [
          "thread.archived",
          "thread.deleted",
          "thread.provider-switched",
          "thread.runtime-mode-updated",
          "thread.interaction-mode-updated",
        ].includes(event.type)
      ) {
        return Effect.sync(() => host.invalidateRun(event.threadId));
      }
      return Effect.void;
    }).pipe(
      Effect.catchCause(() => Effect.promise(() => host.dispose())),
      Effect.forkScoped,
    );
    return CodeModeDispatch.of({
      invoke: (scope, runId, name, args, signal) => {
        const dispatch = Effect.gen(function* () {
          signal.throwIfAborted();
          const live = yield* readMutationCaller();
          if (live.caller.activeRunId !== runId) {
            return yield* failure(new Error("The execution's originating turn has ended."));
          }
          const toolName = name as keyof typeof built.tools;
          const result = yield* built
            .handle(toolName, args as Tool.ParametersEncoded<CallableTool>)
            .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
          return { failed: result.isFailure, value: result.encodedResult };
        }).pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.catch((error) => Effect.succeed({ failed: true, value: error })),
        );
        return Effect.runPromiseWith(context)(dispatch, { signal }).then((outcome) => {
          if (outcome.failed) throw outcome.value;
          return outcome.value;
        });
      },
    });
  }),
);
const common = {
  success: CodeModeExecutionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [CodeModeService, McpInvocationContext, ThreadManagementService],
};
export const CodeModeToolkit = Toolkit.make(
  Tool.make("t3_code_mode_exec", {
    ...common,
    description:
      "Execute a JavaScript async function body in an isolated, supervised process on this T3 environment. Use t3.<existing_tool_name>(args), await, Promise.all, console.log, and return. Discover orchestration/thread tool schemas with t3_code_mode_describe. Tool results are JSON values; failures reject with error.code/message. No filesystem, network, imports, or timers. Await every call. Calls keep existing permissions; command acceptance does not mean agent work finished. Returns an executionId for wait/cancel when still running. Supply a stable clientRequestId for retryable submission: the same key and code retrieves the existing execution while retained, never replays it. Default yield 1000ms, timeout 60000ms including process startup. Limits: 1000ms guest CPU excluding tool waits, 16MiB guest heap, 32 calls total, 8 in flight per script, 32 in flight per environment, 2 scripts per session, 8 per environment in one persistent native QuickJS host with reusable evaluation threads, 64KiB per value, 256KiB journal. Cancellation interrupts and disposes the guest runtime and interrupts calls, but does not stop already-created child tasks. Recent journals survive restart; interrupted scripts are failed, never replayed.",
    parameters: CodeModeExecInput,
    dependencies: [
      ...common.dependencies,
      McpSessionRegistry,
      ThreadManagementService,
      CodeModeDispatch,
    ],
  }),
  Tool.make("t3_code_mode_wait", {
    ...common,
    parameters: CodeModeWaitInput,
    description:
      "Wait up to waitMs (default 1000, max 30000) for code execution. includeCalls retrieves its durable call journal, including results already acknowledged by orchestrator reads. Active handles belong to their credential; after completion or server restart, the same thread and provider can recover them with a new credential. The environment retains 32 recent handles and submission keys; inspect durable thread state before retrying evicted executions.",
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_code_mode_cancel", {
    ...common,
    parameters: CodeModeCancelInput,
    description:
      "Cancel this session's code execution and interrupt nested calls. Already accepted commands and durable child tasks are not rolled back or cancelled.",
  }),
  Tool.make("t3_code_mode_describe", {
    parameters: Schema.Struct({ tool: Schema.optional(Schema.String) }),
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    description:
      "Without tool, list callable orchestration/thread tool names and descriptions. Supply a tool name to get its current input and success JSON schemas. These exact tool names are methods on t3 in code mode.",
  }).annotate(Tool.Readonly, true),
);

const failure = (error: unknown) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: error instanceof Error ? error.message : String(error),
  });

export const CodeModeHandlersLive = CodeModeToolkit.toLayer({
  t3_code_mode_describe: ({ tool: name }) =>
    Effect.gen(function* () {
      if (name === undefined)
        return Object.values(callable.tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
        }));
      const tool = callable.tools[name as keyof typeof callable.tools];
      if (!Object.hasOwn(callable.tools, name))
        return yield* failure(new Error(`Unknown code mode tool: ${name}`));
      return {
        name: tool.name,
        description: tool.description,
        parameters: Tool.getJsonSchema(tool),
        success: Tool.getJsonSchemaFromSchema(tool.successSchema),
      };
    }),
  t3_code_mode_exec: (input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* readMutationCaller();
      const host = yield* CodeModeService;
      const registry = yield* McpSessionRegistry;
      const dispatch = yield* CodeModeDispatch;
      const controller = new AbortController();
      const invoke = (name: string, args: unknown, signal: AbortSignal) =>
        dispatch.invoke(scope, caller.activeRunId, name, args, signal);
      // HTTP cancellation must not leave a subscription between registration and admission.
      const executionId = yield* Effect.gen(function* () {
        const unsubscribe = yield* registry.onRevoke(scope.providerSessionId, () =>
          controller.abort(),
        );
        return yield* Effect.tryPromise({
          try: () =>
            host.start({
              ...input,
              timeoutMs: input.timeoutMs ?? 60_000,
              scope,
              controller,
              tools: Object.keys(callable.tools),
              invoke,
              onSettled: unsubscribe,
              runId: caller.activeRunId ?? undefined,
            }),
          catch: (error) => {
            unsubscribe();
            return failure(error);
          },
        });
      }).pipe(Effect.uninterruptible);
      const live = yield* readMutationCaller().pipe(Effect.catch(() => Effect.succeed(null)));
      if (live === null || live.caller.activeRunId !== caller.activeRunId) {
        yield* Effect.promise(() => host.cancel(executionId, scope));
      }
      return yield* Effect.tryPromise({
        try: () => host.wait(executionId, scope, input.yieldAfterMs ?? 1_000),
        catch: failure,
      });
    }),
  t3_code_mode_wait: (input) =>
    Effect.gen(function* () {
      const host = yield* CodeModeService;
      const { scope } = yield* readCaller();
      return yield* Effect.tryPromise({
        try: () => host.wait(input.executionId, scope, input.waitMs ?? 1_000, input.includeCalls),
        catch: failure,
      });
    }),
  t3_code_mode_cancel: (input) =>
    Effect.gen(function* () {
      const host = yield* CodeModeService;
      const { scope } = yield* readCaller();
      return yield* Effect.tryPromise({
        try: () => host.cancel(input.executionId, scope),
        catch: failure,
      });
    }),
});
