import {
  AuthTerminalOperateScope,
  ExtensionOperationError,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import {
  TERMINAL_SESSIONS_API,
  type TerminalSessionMetadata,
  type TerminalSessionsListEvent,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const inspectInput = Schema.decodeUnknownSync(
  Schema.Struct({
    terminalId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
  }),
  { onExcessProperty: "error" },
);
// An empty Struct does not reject excess properties, so the no-input stream
// validates the shape by hand.
const listInput = (input: unknown) =>
  input === undefined ||
  input === null ||
  (typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0);
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "terminal.api", detail });
const maxQueuedListEvents = 64;
const maxListedTerminals = 128;

/** The public projection shared by inspect, the list stream and control results. */
const projectSummary = (metadata: TerminalSummary): TerminalSessionMetadata => ({
  terminalId: metadata.terminalId,
  status: metadata.status,
  label: metadata.label,
  hasRunningSubprocess: metadata.hasRunningSubprocess,
  exitCode: metadata.exitCode,
  exitSignal: metadata.exitSignal,
  updatedAt: metadata.updatedAt,
});
const withinBounds = (metadata: TerminalSummary) =>
  metadata.terminalId.length <= 128 &&
  metadata.label.length <= 128 &&
  metadata.updatedAt.length <= 64;

interface ResolvedScope {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export function createTerminalApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly terminal: Pick<TerminalManager["Service"], "inspect" | "subscribeMetadata">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (
    principal: { readonly environmentId: string; readonly scopes: readonly string[] } | undefined,
  ) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthTerminalOperateScope);
  const invoke = Effect.fn("TerminalApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    principal: { readonly environmentId: string; readonly scopes: readonly string[] } | undefined,
  ) {
    signal.throwIfAborted();
    if (method !== "inspect") return yield* failure("Terminal API method is unavailable.");
    if (!authorized(principal)) return yield* failure("Terminal authority is unavailable.");
    if (!context.resource.threadId) return yield* failure("Terminal API requires a thread scope.");
    const safe = yield* Effect.try({
      try: () => inspectInput(input),
      catch: () => failure("Invalid terminal inspection request."),
    });
    const scope = yield* resolve(context);
    const metadata = yield* dependencies.terminal
      .inspect({
        threadId: context.resource.threadId,
        terminalId: safe.terminalId,
      })
      .pipe(Effect.catchCause(() => failure("Terminal session cannot be inspected.")));
    signal.throwIfAborted();
    const result =
      metadata === null
        ? null
        : metadata.threadId !== context.resource.threadId ||
            metadata.terminalId !== safe.terminalId ||
            metadata.cwd !== scope.cwd ||
            metadata.worktreePath !== scope.worktreePath
          ? yield* failure("Terminal session is unavailable in the requested workspace.")
          : metadata.label.length > 128 || metadata.updatedAt.length > 64
            ? yield* failure("Terminal metadata exceeds the public bounds.")
            : projectSummary(metadata);
    yield* resolve(scope.context);
    signal.throwIfAborted();
    return result;
  });
  return {
    providerId: "t3.host-terminal",
    definition: TERMINAL_SESSIONS_API,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(invoke(method, input, context, signal, metadata.principal), { signal }),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "list") throw failure("Terminal sessions stream is unavailable.");
      if (resumeCursor !== undefined)
        throw failure("Terminal sessions stream resume is unsupported.");
      if (!authorized(metadata.principal)) throw failure("Terminal authority is unavailable.");
      if (!listInput(input)) throw failure("Invalid terminal sessions request.");
      const threadId = context.resource.threadId;
      if (!threadId) throw failure("Terminal sessions require a thread scope.");

      const queue: ApiStreamEvent[] = [];
      let finished = false;
      let aborted = signal.aborted;
      let wake: (() => void) | null = null;
      let cleanup: (() => void) | null = null;
      let setup: Promise<void> | null = null;
      let setupFailure: unknown = null;
      const controller = new AbortController();
      const runSignal = AbortSignal.any([signal, controller.signal]);
      let removeAbortListener: (() => void) | null = null;

      const finish = () => {
        finished = true;
        cleanup?.();
        cleanup = null;
        removeAbortListener?.();
        removeAbortListener = null;
      };
      const push = (event: ApiStreamEvent) => {
        if (finished || aborted) return;
        if (queue.length >= maxQueuedListEvents) {
          queue.length = 0;
          queue.push({
            type: "closed",
            value: { kind: "closed", reason: "overflow" } satisfies TerminalSessionsListEvent,
          });
          finish();
        } else {
          queue.push(event);
        }
        wake?.();
        wake = null;
      };
      const offer = (event: TerminalMetadataStreamEvent, scope: ResolvedScope) => {
        const inScope = (summary: TerminalSummary) =>
          summary.threadId === threadId &&
          summary.cwd === scope.cwd &&
          summary.worktreePath === scope.worktreePath;
        switch (event.type) {
          case "snapshot": {
            const terminals = event.terminals.filter(inScope);
            if (terminals.some((summary) => !withinBounds(summary))) {
              push({
                type: "closed",
                value: {
                  kind: "closed",
                  reason: "terminal-error",
                } satisfies TerminalSessionsListEvent,
              });
              finish();
              return;
            }
            if (terminals.length > maxListedTerminals) {
              push({
                type: "closed",
                value: {
                  kind: "closed",
                  reason: "overflow",
                } satisfies TerminalSessionsListEvent,
              });
              finish();
              return;
            }
            push({
              type: "snapshot",
              value: {
                kind: "snapshot",
                terminals: terminals.map(projectSummary),
              } satisfies TerminalSessionsListEvent,
            });
            return;
          }
          case "upsert": {
            if (!inScope(event.terminal)) return;
            if (!withinBounds(event.terminal)) {
              push({
                type: "closed",
                value: {
                  kind: "closed",
                  reason: "terminal-error",
                } satisfies TerminalSessionsListEvent,
              });
              finish();
              return;
            }
            push({
              type: "data",
              value: {
                kind: "upsert",
                terminal: projectSummary(event.terminal),
              } satisfies TerminalSessionsListEvent,
            });
            return;
          }
          case "remove": {
            if (event.threadId !== threadId) return;
            push({
              type: "data",
              value: {
                kind: "remove",
                terminalId: event.terminalId,
              } satisfies TerminalSessionsListEvent,
            });
          }
        }
      };
      const abort = () => {
        aborted = true;
        controller.abort();
        queue.length = 0;
        finish();
        wake?.();
        wake = null;
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);

      const iterable: AsyncIterable<ApiStreamEvent> = {
        [Symbol.asyncIterator]() {
          let returned = false;
          const failIfAborted = () => {
            if (aborted || runSignal.aborted)
              throw runSignal.reason ?? failure("Stream cancelled.");
          };
          const finishIterator = async () => {
            controller.abort();
            finish();
          };
          return {
            async next() {
              if (returned) return { done: true, value: undefined };
              failIfAborted();
              setup ??= (async () => {
                try {
                  const scope = await Effect.runPromise(resolve(context), {
                    signal: runSignal,
                  });
                  await metadata.assertAuthority?.();
                  const unsubscribe = await Effect.runPromise(
                    dependencies.terminal.subscribeMetadata((event) =>
                      Effect.sync(() => offer(event, scope)),
                    ),
                    { signal: runSignal },
                  );
                  if (finished || runSignal.aborted) unsubscribe();
                  else cleanup = unsubscribe;
                } catch (error) {
                  setupFailure = error;
                  finish();
                  throw error;
                }
              })();
              try {
                await setup;
                if (setupFailure !== null) throw setupFailure;
                failIfAborted();
                // eslint-disable-next-line no-unmodified-loop-condition
                while (queue.length === 0 && !finished) {
                  await new Promise<void>((resolveWait) => {
                    wake = resolveWait;
                  });
                  failIfAborted();
                }
                failIfAborted();
                const value = queue.shift();
                if (!value) {
                  await finishIterator();
                  returned = true;
                  return { done: true, value: undefined };
                }
                return { done: false, value };
              } catch (error) {
                await finishIterator();
                returned = true;
                throw error;
              }
            },
            async return() {
              returned = true;
              abort();
              await finishIterator();
              return { done: true, value: undefined };
            },
          };
        },
      };
      return iterable;
    },
  };
}

export const makeTerminalApiProvider = Effect.fn("TerminalApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createTerminalApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    terminal: yield* TerminalManager,
  });
});
