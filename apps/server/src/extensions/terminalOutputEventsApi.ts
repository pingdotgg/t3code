import { AuthTerminalOperateScope, ExtensionOperationError } from "@t3tools/contracts";
import {
  TERMINAL_OUTPUT_EVENTS_API,
  type TerminalOutputEventsClosed,
  type TerminalOutputEventsExit,
  type TerminalOutputEventsOutput,
  type TerminalOutputEventsReset,
  type TerminalOutputEventsSnapshot,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { TerminalManager, type TerminalOutputObservationEvent } from "../terminal/Manager.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const inputSchema = Schema.Struct({
  terminalId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
});
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "terminal.output-events", detail });
const maxQueuedEvents = 8;
const maxQueuedBytes = 256 * 1024;
const maxChunkUnits = 8_192;
const maxChunks = 64;

function splitOutput(
  data: string,
  fixed: Omit<TerminalOutputEventsOutput, "chunkIndex" | "chunkCount" | "data">,
) {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + maxChunkUnits, data.length);
    if (end < data.length) {
      const previous = data.charCodeAt(end - 1);
      const next = data.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  if (chunks.length === 0) chunks.push("");
  if (chunks.length > maxChunks) throw failure("Terminal output event exceeds chunk bounds.");
  const values = chunks.map((chunk, chunkIndex) => ({
    ...fixed,
    chunkIndex,
    chunkCount: chunks.length,
    data: chunk,
  }));
  if (
    values.some(
      (value) =>
        Buffer.byteLength(
          JSON.stringify({
            streamId: "x".repeat(128),
            sequence: Number.MAX_SAFE_INTEGER,
            type: "data",
            value,
          }),
          "utf8",
        ) >
        64 * 1024,
    )
  ) {
    throw failure("Terminal output event exceeds encoded frame bounds.");
  }
  return values;
}

function publicEvents(event: TerminalOutputObservationEvent): readonly ApiStreamEvent[] {
  switch (event.type) {
    case "snapshot":
      return [
        {
          type: "snapshot",
          value: {
            kind: "snapshot",
            terminalId: event.terminalId,
            streamEpoch: event.sourceEpoch,
            status: event.snapshot.status,
            contents: event.snapshot.contents,
            retainedByteLength: event.snapshot.retainedByteLength,
            truncated: event.snapshot.truncated,
            clearGeneration: event.clearGeneration,
            contentsUnitStart: event.contentsUnitStart,
            boundarySequence: event.sequence,
          } satisfies TerminalOutputEventsSnapshot,
        },
      ];
    case "output": {
      const fixed = {
        kind: "output" as const,
        terminalId: event.terminalId,
        streamEpoch: event.sourceEpoch,
        sequence: event.sequence,
      };
      return splitOutput(event.data, fixed).map((value) => ({ type: "data" as const, value }));
    }
    case "cleared":
      return [
        {
          type: "reset",
          value: {
            kind: "reset",
            terminalId: event.terminalId,
            streamEpoch: event.sourceEpoch,
            sequence: event.sequence,
            clearGeneration: event.clearGeneration,
            reason: "history-cleared",
          } satisfies TerminalOutputEventsReset,
        },
      ];
    case "exited":
      return [
        {
          type: "data",
          value: {
            kind: "exit",
            terminalId: event.terminalId,
            streamEpoch: event.sourceEpoch,
            sequence: event.sequence,
            exitCode: event.exitCode,
            exitSignal: event.exitSignal,
          } satisfies TerminalOutputEventsExit,
        },
      ];
    case "closed":
      return [
        {
          type: "closed",
          value: {
            kind: "closed",
            terminalId: event.terminalId,
            streamEpoch: event.sourceEpoch,
            reason: event.reason,
          } satisfies TerminalOutputEventsClosed,
        },
      ];
  }
}

interface QueueGroup {
  readonly events: readonly ApiStreamEvent[];
  readonly rawBytes: number;
  readonly countsTowardNativeLimit: boolean;
  index: number;
}

export function createTerminalOutputEventsApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly terminal: Pick<TerminalManager["Service"], "subscribeOutput">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  return {
    providerId: "t3.host-terminal-output-events",
    definition: TERMINAL_OUTPUT_EVENTS_API,
    requiresRootAuthority: true,
    invoke: () => Promise.reject(failure("Terminal output events has no methods.")),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "subscribe") throw failure("Terminal output events stream is unavailable.");
      if (resumeCursor !== undefined)
        throw failure("Terminal output stream resume is unsupported.");
      const safe = (() => {
        try {
          return Schema.decodeUnknownSync(inputSchema, { onExcessProperty: "error" })(input);
        } catch {
          throw failure("Invalid terminal output events request.");
        }
      })();
      const principal = metadata.principal;
      if (
        !principal ||
        principal.environmentId !== dependencies.environmentId ||
        !principal.scopes.includes(AuthTerminalOperateScope)
      ) {
        throw failure("Terminal authority is unavailable.");
      }
      if (!context.resource.threadId)
        throw failure("Terminal output events requires a thread scope.");

      const queue: QueueGroup[] = [];
      let queuedNativeEvents = 0;
      let queuedBytes = 0;
      let snapshotDelivered = false;
      let wake: (() => void) | null = null;
      let cleanup: (() => void) | null = null;
      let finished = false;
      let aborted = signal.aborted;
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
      const enqueue = (event: TerminalOutputObservationEvent) => {
        if (finished || aborted) return;
        const rawBytes = Buffer.byteLength(
          event.type === "snapshot"
            ? event.snapshot.contents
            : event.type === "output"
              ? event.data
              : "",
          "utf8",
        );
        if (
          rawBytes > maxQueuedBytes ||
          queuedNativeEvents >= maxQueuedEvents ||
          queuedBytes + rawBytes > maxQueuedBytes
        ) {
          const initial = queue[0];
          const preserveSnapshot = initial?.index === 0 && initial.events[0]?.type === "snapshot";
          queue.length = 0;
          queuedNativeEvents = preserveSnapshot ? 1 : 0;
          queuedBytes = preserveSnapshot ? initial!.rawBytes : 0;
          if (preserveSnapshot) queue.push(initial!);
          queue.push({
            events: [
              {
                type: "closed",
                value: {
                  kind: "closed",
                  terminalId: safe.terminalId,
                  streamEpoch: event.sourceEpoch,
                  reason: "overflow",
                } satisfies TerminalOutputEventsClosed,
              },
            ],
            rawBytes: 0,
            countsTowardNativeLimit: false,
            index: 0,
          });
          finish();
        } else {
          queue.push({
            events: publicEvents(event),
            rawBytes,
            countsTowardNativeLimit: true,
            index: 0,
          });
          queuedNativeEvents += 1;
          queuedBytes += rawBytes;
          if (
            event.type === "snapshot" &&
            (event.snapshot.status === "exited" || event.snapshot.status === "error")
          ) {
            finish();
          }
          if (event.type === "exited" || event.type === "closed") {
            finish();
          }
        }
        wake?.();
        wake = null;
      };
      const failSetup = (error: unknown) => {
        if (finished || aborted) return;
        setupFailure = error;
        finish();
        wake?.();
        wake = null;
      };
      const abort = () => {
        aborted = true;
        controller.abort();
        queue.length = 0;
        queuedNativeEvents = 0;
        queuedBytes = 0;
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
                  const scope = await Effect.runPromise(resolve(context), { signal: runSignal });
                  await metadata.assertAuthority?.();
                  await Effect.runPromise(
                    dependencies.terminal.subscribeOutput(
                      { threadId: context.resource.threadId!, terminalId: safe.terminalId },
                      (event) => {
                        try {
                          if (
                            event.type === "snapshot" &&
                            (event.snapshot.threadId !== context.resource.threadId ||
                              event.snapshot.terminalId !== safe.terminalId ||
                              event.snapshot.cwd !== scope.cwd ||
                              event.snapshot.worktreePath !== scope.worktreePath)
                          ) {
                            failSetup(
                              failure("Terminal output is unavailable in the requested workspace."),
                            );
                            return;
                          }
                          enqueue(event);
                        } catch (error) {
                          const hasSnapshot =
                            snapshotDelivered ||
                            queue.some((group) => group.events[0]?.type === "snapshot");
                          if (hasSnapshot) {
                            const initial = queue[0];
                            const preserveSnapshot =
                              initial?.index === 0 && initial.events[0]?.type === "snapshot";
                            queue.length = 0;
                            queuedNativeEvents = preserveSnapshot ? 1 : 0;
                            queuedBytes = preserveSnapshot ? initial!.rawBytes : 0;
                            if (preserveSnapshot) queue.push(initial!);
                            queue.push({
                              events: [
                                {
                                  type: "closed",
                                  value: {
                                    kind: "closed",
                                    terminalId: safe.terminalId,
                                    streamEpoch: event.sourceEpoch,
                                    reason: "terminal-error",
                                  } satisfies TerminalOutputEventsClosed,
                                },
                              ],
                              rawBytes: 0,
                              countsTowardNativeLimit: false,
                              index: 0,
                            });
                            finish();
                            wake?.();
                            wake = null;
                          } else {
                            failSetup(error);
                          }
                        }
                      },
                    ),
                    { signal: runSignal },
                  ).then((unsubscribe) => {
                    if (finished || runSignal.aborted) unsubscribe();
                    else cleanup = unsubscribe;
                    if (setupFailure !== null) throw setupFailure;
                  });
                } catch (error) {
                  finish();
                  throw error;
                }
              })();
              try {
                await setup;
                failIfAborted();
                // The synchronous native callback may finish this observer while next() is waiting.
                // eslint-disable-next-line no-unmodified-loop-condition
                while (queue.length === 0 && !finished) {
                  await new Promise<void>((resolveWait) => {
                    wake = resolveWait;
                  });
                  failIfAborted();
                }
                failIfAborted();
                const group = queue[0];
                if (!group) {
                  await finishIterator();
                  returned = true;
                  return { done: true, value: undefined };
                }
                const value = group.events[group.index++]!;
                if (value.type === "snapshot") snapshotDelivered = true;
                if (group.index >= group.events.length) {
                  queue.shift();
                  if (group.countsTowardNativeLimit) queuedNativeEvents -= 1;
                  queuedBytes -= group.rawBytes;
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

export const makeTerminalOutputEventsApiProvider = Effect.fn("TerminalOutputEventsApi.make")(
  function* () {
    const environment = yield* ServerEnvironment;
    return createTerminalOutputEventsApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      terminal: yield* TerminalManager,
    });
  },
);
