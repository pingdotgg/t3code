import {
  AuthTerminalOperateScope,
  ExtensionOperationError,
  TerminalAttachInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { TERMINAL_CONTROL_API } from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const decodeOptions = { onExcessProperty: "error" } as const;
const decoders = {
  open: Schema.decodeUnknownSync(TerminalOpenInput, decodeOptions),
  attach: Schema.decodeUnknownSync(TerminalAttachInput, decodeOptions),
  write: Schema.decodeUnknownSync(TerminalWriteInput, decodeOptions),
  resize: Schema.decodeUnknownSync(TerminalResizeInput, decodeOptions),
  clear: Schema.decodeUnknownSync(TerminalClearInput, decodeOptions),
  restart: Schema.decodeUnknownSync(TerminalRestartInput, decodeOptions),
  close: Schema.decodeUnknownSync(TerminalCloseInput, decodeOptions),
} as const;
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "terminal.control", detail });

interface ResolvedScope {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export function createTerminalControlApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly terminal: Pick<
      TerminalManager["Service"],
      | "open"
      | "openOrAttach"
      | "inspect"
      | "write"
      | "resize"
      | "clear"
      | "restart"
      | "close"
      | "subscribeMetadata"
    >;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const decode = <K extends keyof typeof decoders>(method: K, input: unknown, threadId: string) =>
    Effect.try({
      try: () =>
        decoders[method]({ ...(input as Record<string, unknown>), threadId }) as ReturnType<
          (typeof decoders)[K]
        >,
      catch: () => failure("Invalid terminal control request."),
    });
  /**
   * The launch identity must equal the view's resolved workspace scope — an
   * omitted worktreePath in a worktree-scoped view would spawn a session whose
   * recorded identity (`null`) never matches the scope, so normalize before
   * comparing rather than only rejecting a mismatched explicit value.
   */
  const checkLaunch = (
    decoded: {
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
    scope: ResolvedScope,
  ) =>
    decoded.cwd !== undefined &&
    (decoded.cwd !== scope.cwd || (decoded.worktreePath ?? null) !== scope.worktreePath)
      ? failure("Terminal control is scoped to the requested workspace.")
      : null;
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause(() => Effect.fail(failure("Terminal control operation failed."))),
    );
  /**
   * An existing session may only be mutated when it belongs to the resolved
   * workspace scope — a terminal on this thread under another cwd/worktree is
   * invisible to this view and must not be written to, closed, or relocated.
   */
  const checkExisting = (scope: ResolvedScope, threadId: string, terminalId: string) =>
    dependencies.terminal.inspect({ threadId, terminalId }).pipe(
      Effect.catchCause(() => Effect.fail(failure("Terminal session cannot be inspected."))),
      Effect.flatMap((metadata) =>
        metadata !== null &&
        (metadata.threadId !== threadId ||
          metadata.cwd !== scope.cwd ||
          metadata.worktreePath !== scope.worktreePath)
          ? Effect.fail(failure("Terminal session is unavailable in the requested workspace."))
          : Effect.void,
      ),
    );
  /** Re-read the session and project it to the public shape, revalidating identity. */
  const readResult = (scope: ResolvedScope, threadId: string, terminalId: string) =>
    dependencies.terminal.inspect({ threadId, terminalId }).pipe(
      Effect.catchCause(() => Effect.fail(failure("Terminal session cannot be inspected."))),
      Effect.flatMap((metadata) =>
        metadata === null ||
        metadata.threadId !== threadId ||
        metadata.cwd !== scope.cwd ||
        metadata.worktreePath !== scope.worktreePath
          ? Effect.fail(failure("Terminal session is unavailable in the requested workspace."))
          : metadata.label.length > 128 || metadata.updatedAt.length > 64
            ? Effect.fail(failure("Terminal metadata exceeds the public bounds."))
            : Effect.succeed({
                terminalId: metadata.terminalId,
                status: metadata.status,
                label: metadata.label,
                hasRunningSubprocess: metadata.hasRunningSubprocess,
                exitCode: metadata.exitCode,
                exitSignal: metadata.exitSignal,
                updatedAt: metadata.updatedAt,
              }),
      ),
    );
  const invoke = Effect.fn("TerminalControlApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    principal: { readonly environmentId: string; readonly scopes: readonly string[] } | undefined,
  ) {
    signal.throwIfAborted();
    if (!(method in decoders)) return yield* failure("Terminal control method is unavailable.");
    if (
      !principal ||
      principal.environmentId !== dependencies.environmentId ||
      !principal.scopes.includes(AuthTerminalOperateScope)
    )
      return yield* failure("Terminal authority is unavailable.");
    const threadId = context.resource.threadId;
    if (!threadId) return yield* failure("Terminal control requires a thread scope.");
    if (input !== null && typeof input === "object" && "threadId" in input)
      return yield* failure("Terminal control takes the thread from the view context.");
    const scope = yield* resolve(context);
    let result: Json = {};
    switch (method) {
      case "open": {
        const safe = yield* decode("open", input, threadId);
        const denied = checkLaunch(safe, scope);
        if (denied) return yield* denied;
        yield* checkExisting(scope, threadId, safe.terminalId);
        yield* run(dependencies.terminal.open(safe));
        result = yield* readResult(scope, threadId, safe.terminalId);
        break;
      }
      case "attach": {
        const safe = yield* decode("attach", input, threadId);
        const denied = checkLaunch(safe, scope);
        if (denied) return yield* denied;
        yield* checkExisting(scope, threadId, safe.terminalId);
        yield* run(dependencies.terminal.openOrAttach(safe));
        result = yield* readResult(scope, threadId, safe.terminalId);
        break;
      }
      case "write": {
        const safe = yield* decode("write", input, threadId);
        yield* checkExisting(scope, threadId, safe.terminalId);
        yield* run(dependencies.terminal.write(safe));
        break;
      }
      case "resize": {
        const safe = yield* decode("resize", input, threadId);
        yield* checkExisting(scope, threadId, safe.terminalId);
        yield* run(dependencies.terminal.resize(safe));
        break;
      }
      case "clear": {
        const safe = yield* decode("clear", input, threadId);
        yield* checkExisting(scope, threadId, safe.terminalId);
        yield* run(dependencies.terminal.clear(safe));
        break;
      }
      case "restart": {
        const safe = yield* decode("restart", input, threadId);
        const denied = checkLaunch(safe, scope);
        if (denied) return yield* denied;
        yield* checkExisting(scope, threadId, safe.terminalId);
        yield* run(dependencies.terminal.restart(safe));
        result = yield* readResult(scope, threadId, safe.terminalId);
        break;
      }
      case "close": {
        const safe = yield* decode("close", input, threadId);
        if (safe.terminalId !== undefined) {
          yield* checkExisting(scope, threadId, safe.terminalId);
          yield* run(dependencies.terminal.close(safe));
          break;
        }
        // Close-all stays inside the resolved scope: enumerate the thread's
        // sessions once and close only the ones this workspace view can see.
        let listed: readonly {
          readonly terminalId: string;
          readonly threadId: string;
          readonly cwd: string;
          readonly worktreePath: string | null;
        }[] = [];
        const unsubscribe = yield* run(
          dependencies.terminal.subscribeMetadata((event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") listed = event.terminals;
            }),
          ),
        );
        unsubscribe();
        for (const terminal of listed) {
          if (
            terminal.threadId === threadId &&
            terminal.cwd === scope.cwd &&
            terminal.worktreePath === scope.worktreePath
          )
            yield* run(
              dependencies.terminal.close({
                threadId,
                terminalId: terminal.terminalId,
                ...(safe.deleteHistory === undefined ? {} : { deleteHistory: safe.deleteHistory }),
              }),
            );
        }
        break;
      }
    }
    yield* resolve(scope.context);
    signal.throwIfAborted();
    return result;
  });
  return {
    providerId: "t3.host-terminal-control",
    definition: TERMINAL_CONTROL_API,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(invoke(method, input, context, signal, metadata.principal), { signal }),
  };
}

export const makeTerminalControlApiProvider = Effect.fn("TerminalControlApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createTerminalControlApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    terminal: yield* TerminalManager,
  });
});
