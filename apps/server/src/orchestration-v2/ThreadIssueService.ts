/**
 * Issues linked to threads: the link and unlink commands every surface (web, MCP) goes through,
 * and the snapshot each link carries so the thread can show a title and state without a tracker
 * read.
 *
 * There is no poller. A snapshot is written when the link is made, refreshed when the thread's
 * turn ends — the agent may have closed or renamed the issue — and refreshed when the user opens
 * the thread after the snapshot has gone stale. Those are the moments the state can have changed
 * and someone is looking; a sweep would spend tracker reads on threads nobody is reading.
 *
 * @module orchestration-v2/ThreadIssueService
 */
import {
  CommandId,
  threadIssueKeysEqual,
  threadIssueRefOf,
  type IssueRef,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadIssueKey,
  type ThreadIssueLink,
  type ThreadIssueLinkSource,
  type ThreadIssueSnapshot,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as IssueService from "../issue/IssueService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** A snapshot older than this is re-read when the thread is opened. */
const STALE_AFTER_MS = 5 * 60_000;
const REFRESH_CONCURRENCY = 4;

export interface LinkThreadIssueInput {
  readonly threadId: ThreadId;
  readonly ref: IssueRef & { readonly host: string };
  readonly url: string;
  readonly source: ThreadIssueLinkSource;
}

export interface UnlinkThreadIssueInput {
  readonly threadId: ThreadId;
  readonly key: ThreadIssueKey;
}

export class ThreadIssueService extends Context.Service<
  ThreadIssueService,
  {
    /** Links the issue and schedules its first snapshot. Linking a linked issue is a no-op. */
    readonly link: (
      input: LinkThreadIssueInput,
    ) => Effect.Effect<{ readonly alreadyLinked: boolean }, Orchestrator.OrchestratorV2Error>;
    readonly unlink: (
      input: UnlinkThreadIssueInput,
    ) => Effect.Effect<{ readonly wasLinked: boolean }, Orchestrator.OrchestratorV2Error>;
    /** Re-reads every link's snapshot now; `staleOnly` skips ones read recently. */
    readonly refresh: (
      threadId: ThreadId,
      options?: { readonly staleOnly?: boolean },
    ) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadIssueService") {}

function sameSnapshot(left: ThreadIssueSnapshot | null, right: ThreadIssueSnapshot): boolean {
  return (
    left !== null &&
    left.displayKey === right.displayKey &&
    left.title === right.title &&
    left.state.category === right.state.category &&
    left.state.name === right.state.name &&
    left.state.closeReason === right.state.closeReason
  );
}

function isStale(link: ThreadIssueLink, nowMs: number): boolean {
  return link.snapshot === null || nowMs - Date.parse(link.snapshot.syncedAt) > STALE_AFTER_MS;
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const issues = yield* IssueService.IssueService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:thread-issue-${tag}:${threadId}:${uuid}`)),
    );

  const shellOf = (threadId: ThreadId): Effect.Effect<OrchestrationV2ThreadShell | null> =>
    orchestrator.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

  const syncLink = Effect.fn("ThreadIssueService.syncLink")(function* (
    threadId: ThreadId,
    link: ThreadIssueLink,
  ) {
    const detail = yield* issues.detail(threadIssueRefOf(link));
    const now = yield* DateTime.now;
    const snapshot: ThreadIssueSnapshot = {
      displayKey: detail.displayKey,
      title: detail.title,
      state: detail.state,
      syncedAt: DateTime.formatIso(now),
    };
    if (sameSnapshot(link.snapshot, snapshot)) return;
    yield* orchestrator.dispatch({
      type: "thread.issue-link.sync",
      commandId: yield* commandId("sync", threadId),
      threadId,
      tracker: link.tracker,
      host: link.host,
      scope: link.scope,
      key: link.key,
      snapshot,
    });
  });

  const refreshThread = Effect.fn("ThreadIssueService.refreshThread")(function* (request: {
    readonly threadId: ThreadId;
    readonly staleOnly: boolean;
  }) {
    const thread = yield* shellOf(request.threadId);
    if (thread === null || thread.deletedAt !== null) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const links = (thread.issues ?? []).filter(
      (link) => !request.staleOnly || isStale(link, nowMs),
    );
    yield* Effect.forEach(
      links,
      (link) =>
        syncLink(thread.id, link).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("thread issue snapshot refresh failed", {
                threadId: thread.id,
                issue: `${link.host}/${link.scope}#${link.key}`,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      { concurrency: REFRESH_CONCURRENCY, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(refreshThread);

  const link: ThreadIssueService["Service"]["link"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* shellOf(input.threadId);
      if (thread?.issues?.some((existing) => threadIssueKeysEqual(existing, input.ref))) {
        return { alreadyLinked: true };
      }
      yield* orchestrator.dispatch({
        type: "thread.issue.link",
        commandId: yield* commandId("link", input.threadId),
        threadId: input.threadId,
        tracker: input.ref.tracker,
        host: input.ref.host,
        scope: input.ref.scope,
        key: input.ref.key,
        projectId: input.ref.projectId,
        url: input.url,
        source: input.source,
      });
      yield* worker.enqueue({ threadId: input.threadId, staleOnly: true });
      return { alreadyLinked: false };
    });

  const unlink: ThreadIssueService["Service"]["unlink"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* shellOf(input.threadId);
      if (!thread?.issues?.some((existing) => threadIssueKeysEqual(existing, input.key))) {
        return { wasLinked: false };
      }
      yield* orchestrator.dispatch({
        type: "thread.issue.unlink",
        commandId: yield* commandId("unlink", input.threadId),
        threadId: input.threadId,
        tracker: input.key.tracker,
        host: input.key.host,
        scope: input.key.scope,
        key: input.key.key,
      });
      return { wasLinked: true };
    });

  const refresh: ThreadIssueService["Service"]["refresh"] = (threadId, options) =>
    worker.enqueue({ threadId, staleOnly: options?.staleOnly ?? false });

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      // A link made from a client (web dispatches the command directly) has no snapshot yet.
      case "thread.issue-synced":
        return (event.payload.issues ?? []).some((link) => link.snapshot === null)
          ? worker.enqueue({ threadId: event.threadId, staleOnly: true })
          : Effect.void;
      case "thread.visited":
        return (event.payload.issues ?? []).length > 0
          ? worker.enqueue({ threadId: event.threadId, staleOnly: true })
          : Effect.void;
      case "run.updated":
        return event.payload.status === "completed" ||
          event.payload.status === "failed" ||
          event.payload.status === "cancelled" ||
          event.payload.status === "interrupted"
          ? worker.enqueue({ threadId: event.threadId, staleOnly: false })
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadIssueService["Service"]["start"] = Effect.fn("ThreadIssueService.start")(
    function* () {
      yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
    },
  );

  return ThreadIssueService.of({ link, unlink, refresh, start, drain: worker.drain });
});

export const layer = Layer.effect(ThreadIssueService, make);
