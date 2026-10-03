import {
  OrchestrationV2CommandOutputError,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  normalizeTerminalOutput,
  type TerminalOutputState,
  TERMINAL_OUTPUT_TAIL_CHARS,
  terminalOutputResumeText,
} from "@t3tools/shared/terminalOutput";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Live command output.
 *
 * Output never becomes an orchestration event. Adapters push raw chunks here
 * (through the session manager), the hub keeps a bounded, normalized tail per
 * running command, and `subscribe` serves one expanded row: the current tail,
 * then coalesced appends, then the persisted final output. Memory is bounded
 * per command and in count, and a client that is not showing the row receives nothing.
 */

/** Fastest a subscriber receives frames while output flows. */
export const COMMAND_OUTPUT_FRAME_INTERVAL_MS = 100;
/** After a subscriber falls behind and is sent the whole tail, it waits this long. */
export const COMMAND_OUTPUT_REPLACE_INTERVAL_MS = 500;
/** Raw text a subscriber may accumulate before it is sent the tail instead. */
const COMMAND_OUTPUT_MAX_APPEND_CHARS = 16 * 1024;
/** Running commands tracked at once; the least recently written is dropped beyond this. */
const MAX_LIVE_COMMANDS = 64;
/** Finished tails kept for a settle that reports no output of its own (an interrupt). */
const MAX_FINISHED_COMMANDS = 16;
/** Final output read from persistence is normalized from at most this many trailing chars. */
const MAX_FINAL_SOURCE_CHARS = TERMINAL_OUTPUT_TAIL_CHARS * 4;

interface Subscriber {
  pendingAppend: string;
  /** The next frame must carry the whole tail. */
  needsReplace: boolean;
  /** `needsReplace` was caused by the subscriber falling behind. */
  overflowed: boolean;
  readonly wake: Queue.Queue<void>;
}

export interface CommandOutputTarget {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}

export interface CommandOutputHubShape {
  /** Add raw output for a running command. Called for every provider chunk. */
  readonly append: (input: CommandOutputTarget & { readonly chunk: string }) => Effect.Effect<void>;
  /**
   * The command settled. Its tail is kept briefly for a settle that carries no
   * output (an interrupt); otherwise the persisted output is what rows show.
   */
  readonly finish: (input: CommandOutputTarget) => Effect.Effect<void>;
  /** Frames for one row until its command settles; see `OrchestrationV2CommandOutputFrame`. */
  readonly subscribe: (
    input: CommandOutputTarget,
  ) => Stream.Stream<OrchestrationV2CommandOutputFrame, OrchestrationV2CommandOutputError>;
}

export class CommandOutputHub extends Context.Service<CommandOutputHub, CommandOutputHubShape>()(
  "t3/orchestration-v2/CommandOutputHub",
) {}

function commandKey(target: CommandOutputTarget): string {
  return `${target.threadId}\u0000${target.itemId}`;
}

function isSettled(item: OrchestrationV2TurnItem): boolean {
  return item.status !== "pending" && item.status !== "running" && item.status !== "waiting";
}

/** The output a row shows from a persisted item, bounded before normalization. */
function persistedCommandOutput(output: string | undefined): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (output === undefined) return { text: "", truncated: false };
  const source =
    output.length > MAX_FINAL_SOURCE_CHARS
      ? output.slice(output.length - MAX_FINAL_SOURCE_CHARS)
      : output;
  const normalized = normalizeTerminalOutput(source);
  return {
    text: normalized.text,
    truncated: normalized.truncated || source.length !== output.length,
  };
}

export const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  // Insertion order doubles as recency: every write re-inserts its entry.
  const tails = new Map<string, TerminalOutputState>();
  const finished = new Map<string, TerminalOutputState>();
  const subscribers = new Map<string, Set<Subscriber>>();

  const wakeAll = (key: string, chunk: string) =>
    Effect.forEach(
      subscribers.get(key) ?? [],
      (subscriber) => {
        if (!subscriber.needsReplace) {
          subscriber.pendingAppend += chunk;
          if (subscriber.pendingAppend.length > COMMAND_OUTPUT_MAX_APPEND_CHARS) {
            subscriber.needsReplace = true;
            subscriber.overflowed = true;
            subscriber.pendingAppend = "";
          }
        }
        return Queue.offer(subscriber.wake, undefined);
      },
      { discard: true },
    );

  const append: CommandOutputHubShape["append"] = ({ chunk, ...target }) =>
    Effect.suspend(() => {
      if (chunk.length === 0) return Effect.void;
      const key = commandKey(target);
      const previous = tails.get(key);
      tails.delete(key);
      tails.set(key, appendTerminalOutput(previous ?? EMPTY_TERMINAL_OUTPUT, chunk));
      if (previous === undefined) {
        while (tails.size > MAX_LIVE_COMMANDS) {
          const oldest = tails.keys().next().value;
          if (oldest === undefined) break;
          tails.delete(oldest);
        }
      }
      return wakeAll(key, chunk);
    });

  const finish: CommandOutputHubShape["finish"] = (target) =>
    Effect.sync(() => {
      const key = commandKey(target);
      const tail = tails.get(key);
      if (tail === undefined) return;
      tails.delete(key);
      finished.set(key, tail);
      while (finished.size > MAX_FINISHED_COMMANDS) {
        const oldest = finished.keys().next().value;
        if (oldest === undefined) break;
        finished.delete(oldest);
      }
    });

  const subscribe: CommandOutputHubShape["subscribe"] = (target) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const key = commandKey(target);
        const wake = yield* Queue.sliding<void>(1);
        const subscriber: Subscriber = {
          pendingAppend: "",
          needsReplace: true,
          overflowed: false,
          wake,
        };
        // Attach before reading anything, so no chunk falls between a read and the attach.
        const keySubscribers = subscribers.get(key) ?? new Set<Subscriber>();
        keySubscribers.add(subscriber);
        subscribers.set(key, keySubscribers);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            keySubscribers.delete(subscriber);
            if (keySubscribers.size === 0 && subscribers.get(key) === keySubscribers) {
              subscribers.delete(key);
            }
          }),
        );

        // The persisted item says when the command is done and what it finally printed.
        // Providers that report output only in item snapshots (ACP, Pi) stream through here too.
        let snapshotOutput: string | undefined;
        let lost: Cause.Cause<unknown> | undefined;
        let settled: Extract<OrchestrationV2TurnItem, { type: "command_execution" }> | undefined;
        const observe = (item: OrchestrationV2TurnItem | undefined) =>
          Effect.suspend(() => {
            if (item === undefined || item.type !== "command_execution") return Effect.void;
            if (isSettled(item)) {
              settled = item;
            } else if (item.output !== undefined && item.output !== snapshotOutput) {
              snapshotOutput = item.output;
            } else {
              return Effect.void;
            }
            subscriber.needsReplace = true;
            return Queue.offer(wake, undefined);
          });
        const fromSequence = yield* eventSink.latestSequence({ threadId: target.threadId });
        yield* eventSink
          .stream({
            threadId: target.threadId,
            afterSequence: fromSequence,
            eventType: "turn-item.updated",
          })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "turn-item.updated" && stored.event.payload.id === target.itemId
                ? observe(stored.event.payload)
                : Effect.void,
            ),
            // Without its event stream the row can never settle: end with an error
            // instead of waiting forever.
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                lost = cause;
              }).pipe(Effect.andThen(Queue.offer(wake, undefined))),
            ),
            Effect.forkScoped,
          );
        const item = yield* projections.getTurnItem(target.threadId, target.itemId);
        // Only command rows have output; anything else would hold a subscription open forever.
        if (item?.type !== "command_execution") {
          return yield* new OrchestrationV2CommandOutputError({
            threadId: target.threadId,
            message: "No such command.",
          });
        }
        yield* observe(item);
        yield* Queue.offer(wake, undefined);

        let lastFrameAt: number | undefined;
        let throttle = COMMAND_OUTPUT_FRAME_INTERVAL_MS;
        let ended = false;
        const nextFrame = Effect.gen(function* (): Effect.fn.Return<
          OrchestrationV2CommandOutputFrame,
          Cause.Done | OrchestrationV2CommandOutputError
        > {
          if (ended) return yield* Cause.done();
          yield* Queue.take(wake);
          if (lost !== undefined) {
            return yield* new OrchestrationV2CommandOutputError({
              threadId: target.threadId,
              message: "Lost the thread's event stream.",
              cause: Cause.squash(lost),
            });
          }
          const now = yield* Clock.currentTimeMillis;
          if (lastFrameAt !== undefined && now - lastFrameAt < throttle) {
            yield* Effect.sleep(throttle - (now - lastFrameAt));
          }
          lastFrameAt = yield* Clock.currentTimeMillis;
          throttle = COMMAND_OUTPUT_FRAME_INTERVAL_MS;
          const tail = tails.get(key);
          if (settled !== undefined) {
            ended = true;
            const lastTail = tail ?? finished.get(key);
            if (settled.output === undefined && lastTail !== undefined) {
              return {
                kind: "replace",
                text: lastTail.text,
                truncated: lastTail.truncated,
                running: false,
              };
            }
            return { kind: "replace", ...persistedCommandOutput(settled.output), running: false };
          }
          if (subscriber.needsReplace || tail === undefined) {
            if (subscriber.overflowed) throttle = COMMAND_OUTPUT_REPLACE_INTERVAL_MS;
            subscriber.needsReplace = false;
            subscriber.overflowed = false;
            subscriber.pendingAppend = "";
            if (tail === undefined) {
              return { kind: "replace", ...persistedCommandOutput(snapshotOutput), running: true };
            }
            // The cursor, style and any unfinished escape ride along so the client
            // applies later appends exactly as the hub does.
            return {
              kind: "replace",
              text: terminalOutputResumeText(tail),
              truncated: tail.truncated,
              running: true,
            };
          }
          const text = subscriber.pendingAppend;
          subscriber.pendingAppend = "";
          return { kind: "append", text, truncated: tail.truncated, running: true };
        });
        return Stream.fromEffectRepeat(nextFrame).pipe(
          Stream.filter((frame) => frame.kind !== "append" || frame.text.length > 0),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof OrchestrationV2CommandOutputError
            ? cause
            : new OrchestrationV2CommandOutputError({
                threadId: target.threadId,
                message: "Failed to read command output.",
                cause,
              }),
        ),
      ),
    );

  return CommandOutputHub.of({ append, finish, subscribe });
});

export const layer: Layer.Layer<
  CommandOutputHub,
  never,
  EventSink.EventSinkV2 | ProjectionStore.ProjectionStoreV2
> = Layer.effect(CommandOutputHub, make);
