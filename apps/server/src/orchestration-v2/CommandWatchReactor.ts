import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type ThreadCommandWatch,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { listLoginShellCandidates } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import {
  COMMAND_WATCH_FAILURE_LIMIT,
  COMMAND_WATCH_LIFETIME_DAYS,
  type CommandWatchRun,
  commandWatchMessage,
  evaluateCommandWatch,
} from "./commandWatch.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

/** Runs at once across the environment. */
const CONCURRENT_RUNS = 4;
const RUN_TIMEOUT_SECONDS = 60;
/** How often watched threads are looked up while any exist, and when none do. */
const ACTIVE_SCAN_MS = 30_000;
const IDLE_SCAN_MS = 5 * 60_000;
/** Output kept from one run. Anything longer than what a wake can carry ends the watch. */
const CAPTURE_LIMIT_BYTES = 64 * 1024;

const watchKey = (threadId: ThreadId, watch: ThreadCommandWatch) =>
  `${threadId} ${watch.id} ${watch.startedAt}`;

/** Only an unsettled thread that is not a subagent, in Full access and default mode, runs watches. */
const mayRun = (
  thread: Pick<
    OrchestrationV2AppThread,
    "lineage" | "settledOverride" | "settledAt" | "runtimeMode" | "interactionMode"
  >,
) =>
  thread.lineage.relationshipToParent !== "subagent" &&
  thread.settledOverride !== "settled" &&
  thread.settledAt === null &&
  thread.runtimeMode === "full-access" &&
  thread.interactionMode === "default";

/**
 * The server's own shell, run non-interactively: the server already loaded the login PATH.
 * Resolved once, since finding the user's shell can read the account database.
 */
const resolveShell = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") {
    return (command: string) => ({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    });
  }
  const environment = yield* HostProcess.Environment;
  const shell = listLoginShellCandidates(platform, environment.SHELL)[0] ?? "/bin/sh";
  return (command: string) => ({ command: shell, args: ["-c", command] });
});

/**
 * Runs the commands threads watch (`watch_command`) and wakes a thread's agent when one prints
 * something it was not told yet. The shared scheduler looks for due watches every few seconds.
 * A thread runs one watch at a time, and none while a turn is running or queued except a new
 * watch's baseline run, so wakes do not pile up behind a long turn. A stop, settle, archive or
 * permission change that ends a watch interrupts its run when the change's event arrives, or at
 * the next look. Due times and failure counts are kept in memory: a restart runs each watch at
 * the next look.
 */
export class CommandWatchReactor extends Context.Service<
  CommandWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One look for due watches. Starts their runs without waiting for them. */
    readonly sweep: Effect.Effect<void>;
    /** Waits until no run is in flight. */
    readonly awaitRuns: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/CommandWatchReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const processes = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const permits = yield* Semaphore.make(CONCURRENT_RUNS);
  const shellInvocation = yield* resolveShell;
  // Keyed by thread: a thread runs one watch at a time.
  const runs = yield* FiberMap.make<ThreadId, void, never>();
  /** The watch each thread is running. */
  const running = new Map<ThreadId, string>();
  const dueAt = new Map<string, number>();
  const failures = new Map<string, number>();
  let watchesChanged = true;
  let nextScanAt = 0;

  const record = Effect.fn("CommandWatchReactor.record")(function* (
    threadId: ThreadId,
    watch: ThreadCommandWatch,
    next: ThreadCommandWatch | null,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) {
    const uuid = yield* crypto.randomUUIDv4();
    yield* engine.dispatch({
      type: "thread.command-watch.sync",
      commandId: CommandId.make(`server:command-watch:${threadId}:${uuid}`),
      threadId,
      watchId: watch.id,
      startedAt: watch.startedAt,
      watch: next,
      ...(wake === undefined
        ? {}
        : { wake: { ...wake, messageId: MessageId.make(`message:command-watch:${uuid}`) } }),
    });
  });

  // A watch whose thread no longer takes wakes still ends. Any other failure, such as a failed
  // write, keeps the watch, so the next run reports the same outcome instead of losing it.
  const end = (
    threadId: ThreadId,
    watch: ThreadCommandWatch,
    wake: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    record(threadId, watch, null, wake).pipe(
      Effect.catchTags({
        OrchestratorDispatchError: (error) =>
          projections
            .getThreadsWithCommandWatches(threadId)
            .pipe(
              Effect.flatMap(([thread]) =>
                thread !== undefined && mayRun(thread)
                  ? Effect.fail(error)
                  : record(threadId, watch, null),
              ),
            ),
      }),
    );

  const execute = Effect.fn("CommandWatchReactor.execute")(function* (
    thread: ProjectionStore.ProjectionThreadCommandWatches,
    watch: ThreadCommandWatch,
  ) {
    const cwd =
      thread.worktreePath ??
      (yield* projects
        .get(thread.projectId)
        .pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.workspaceRoot })),
        ));
    if (cwd === null || !(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) {
      return { kind: "failed", reason: "could not run: its working directory is missing" } as const;
    }
    const shell = shellInvocation(watch.command);
    return yield* processes
      .run({
        command: shell.command,
        args: shell.args,
        cwd,
        timeout: `${RUN_TIMEOUT_SECONDS} seconds`,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: CAPTURE_LIMIT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.flatMap((output) =>
          output.timedOut
            ? Effect.succeed<CommandWatchRun>({
                kind: "failed",
                reason: `timed out after ${RUN_TIMEOUT_SECONDS} seconds`,
              })
            : output.code === null
              ? Effect.succeed<CommandWatchRun>({
                  kind: "failed",
                  reason: "was stopped by a signal",
                })
              : crypto.digest("SHA-256", new TextEncoder().encode(output.stdout.trim())).pipe(
                  Effect.map((digest): CommandWatchRun => ({
                    kind: "exited",
                    code: output.code ?? 0,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    stdoutHash: Hex.encode(digest),
                    stdoutTruncated: output.stdoutTruncated,
                  })),
                ),
        ),
        Effect.catch((error) =>
          Effect.succeed<CommandWatchRun>({
            kind: "failed",
            reason: `could not start: ${error.message}`,
          }),
        ),
      );
  });

  const runWatch = Effect.fn("CommandWatchReactor.runWatch")(function* (
    threadId: ThreadId,
    watchId: string,
  ) {
    // The look that chose this watch may be stale by the time a permit frees up.
    const [thread] = yield* projections.getThreadsWithCommandWatches(threadId);
    const watch = thread?.commandWatches.find((candidate) => candidate.id === watchId);
    if (thread === undefined || watch === undefined || !mayRun(thread)) return;
    const key = watchKey(threadId, watch);
    // A baseline run wakes nobody, so it does not wait for the turn that started the watch.
    if (thread.busy && watch.lastOutputHash !== null) {
      // A turn started meanwhile: look again once it is done instead of a full interval later.
      dueAt.delete(key);
      return;
    }
    const outcome = evaluateCommandWatch(watch, yield* execute(thread, watch));
    if (outcome.kind === "quiet") {
      failures.delete(key);
      return;
    }
    if (outcome.kind === "failed") {
      const count = (failures.get(key) ?? 0) + 1;
      if (count < COMMAND_WATCH_FAILURE_LIMIT) {
        failures.set(key, count);
        return;
      }
      yield* end(threadId, watch, commandWatchMessage(watch, outcome));
      failures.delete(key);
      return;
    }
    failures.delete(key);
    if (outcome.kind === "baseline") return yield* record(threadId, watch, outcome.next);
    if (outcome.kind === "too-long") {
      return yield* end(threadId, watch, commandWatchMessage(watch, outcome));
    }
    const wake = commandWatchMessage(watch, outcome);
    return yield* outcome.exhausted
      ? end(threadId, watch, wake)
      : record(threadId, watch, outcome.next, wake);
  });

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // The scheduler ticks every few seconds and the scan reads every thread row, so it runs only
    // when a watch changed or a backstop passed: often while watches exist, rarely when none do.
    if (!watchesChanged && now < nextScanAt) return;
    watchesChanged = false;
    const threads = yield* projections.getThreadsWithCommandWatches();
    nextScanAt = now + (threads.length > 0 ? ACTIVE_SCAN_MS : IDLE_SCAN_MS);
    const present = new Set(
      threads.flatMap((thread) => thread.commandWatches.map((watch) => watchKey(thread.id, watch))),
    );
    for (const cache of [dueAt, failures]) {
      for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
    }
    // A run whose watch ended while the event stream was not listening stops here.
    for (const [threadId, key] of running) {
      if (!present.has(key)) yield* FiberMap.remove(runs, threadId);
    }
    for (const thread of threads) {
      if (!mayRun(thread)) {
        // The orchestrator ends these on the transition; a watch left from before that ends here.
        yield* Effect.forEach(
          thread.commandWatches,
          (watch) => record(thread.id, watch, null).pipe(Effect.ignore),
          { discard: true },
        );
        continue;
      }
      const lifetimeStart = now - COMMAND_WATCH_LIFETIME_DAYS * 24 * 60 * 60_000;
      const expired = thread.commandWatches.filter(
        (candidate) => Date.parse(candidate.startedAt) <= lifetimeStart,
      );
      yield* Effect.forEach(
        expired,
        (watch) =>
          end(thread.id, watch, commandWatchMessage(watch, { kind: "expired" })).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("command watch expiry failed", { threadId: thread.id, cause }),
            ),
          ),
        { discard: true },
      );
      if (expired.length > 0 || running.has(thread.id)) continue;
      // The most overdue first, so a slow watch cannot keep the thread's others from running.
      // While a turn runs, only a watch still taking its baseline may run.
      const watch = thread.commandWatches
        .filter(
          (candidate) =>
            (!thread.busy || candidate.lastOutputHash === null) &&
            (dueAt.get(watchKey(thread.id, candidate)) ?? 0) <= now,
        )
        .toSorted(
          (left, right) =>
            (dueAt.get(watchKey(thread.id, left)) ?? 0) -
            (dueAt.get(watchKey(thread.id, right)) ?? 0),
        )[0];
      if (watch === undefined) continue;
      const key = watchKey(thread.id, watch);
      dueAt.set(key, now + watch.everyMinutes * 60_000);
      running.set(thread.id, key);
      yield* FiberMap.run(
        runs,
        thread.id,
        permits
          .withPermits(1)(runWatch(thread.id, watch.id))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("command watch run failed", { threadId: thread.id, cause }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (running.get(thread.id) === key) running.delete(thread.id);
              }),
            ),
          ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("command watch sweep failed", { cause })),
    Effect.withSpan("CommandWatchReactor.sweep"),
  );

  /** Interrupts a thread's run as soon as an event shows its watch can no longer run. */
  const onEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.suspend(() => {
      if (event.type === "thread.command-watches-updated") watchesChanged = true;
      const key = running.get(event.threadId);
      if (key === undefined) return Effect.void;
      if (event.type === "thread.deleted") return FiberMap.remove(runs, event.threadId);
      if (!("payload" in event) || !isAppThread(event)) return Effect.void;
      const thread = event.payload;
      const stillOn =
        thread.archivedAt === null &&
        mayRun(thread) &&
        (thread.commandWatches ?? []).some((watch) => watchKey(thread.id, watch) === key);
      return stillOn ? Effect.void : FiberMap.remove(runs, event.threadId);
    });

  const start: CommandWatchReactor["Service"]["start"] = Effect.fn("CommandWatchReactor.start")(
    function* () {
      // Losing the stream only delays a stop to the next look, so it is logged and resubscribed.
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("command watch event stream failed", { cause }),
          ),
          Effect.andThen(Effect.sync(() => (watchesChanged = true))),
          Effect.repeat(Schedule.spaced("5 seconds")),
        ),
      );
    },
  );

  return {
    start,
    sweep,
    awaitRuns: FiberMap.awaitEmpty(runs).pipe(Effect.ignore),
  } satisfies CommandWatchReactor["Service"];
});

/** Full-thread events carry the thread as it is after the change. */
function isAppThread(
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { readonly payload: OrchestrationV2AppThread }> {
  switch (event.type) {
    case "thread.archived":
    case "thread.settled":
    case "thread.pull-request-synced":
    case "thread.command-watches-updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
      return true;
    default:
      return false;
  }
}

export const layer = Layer.effect(CommandWatchReactor, make);

/** Starts the reactor and registers its look for due watches with the shared scheduler. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* CommandWatchReactor;
    const scheduler = yield* Scheduler.Scheduler;
    yield* reactor.start();
    yield* scheduler.register("command-watch", reactor.sweep);
  }),
);
