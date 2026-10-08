import {
  CommandId,
  normalizeWorkItemLinkKey,
  type IssueRef,
  type ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as IssueService from "../issue/IssueService.ts";
import { IssueProviderError } from "../issue/IssueProvider.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const isIssueProviderError = Schema.is(IssueProviderError);

const OPEN_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const SLOW_SYNC_INTERVAL_MS = 30 * 60 * 1_000;
const encodeSyncKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number, Schema.String]),
  ),
);
const encodeSourceKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
);

function spreadInterval(key: string, intervalMs: number): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return intervalMs * (0.8 + 0.4 * (hash / 0xffffffff));
}

interface LinkEntry {
  readonly thread: ProjectionStore.ProjectionThreadIssues;
  readonly link: ThreadIssueLink;
}

export class IssueSyncReactor extends Context.Service<
  IssueSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IssueSyncReactor") {}

const make = Effect.gen(function* () {
  const summaryReads = yield* Semaphore.make(4);
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const issues = yield* IssueService.IssueService;
  const crypto = yield* Crypto.Crypto;
  const lastSyncedAt = new Map<string, number>();
  const retryAt = new Map<string, number>();
  const sourceRetryAt = new Map<string, number>();
  const observedLinks = new Map<ThreadId, ReadonlySet<CommandId>>();
  const requestedLinks = new Map<ThreadId, Set<CommandId>>();

  const logSkipped =
    (fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("issue sync skipped", fields);

  const sweep = Effect.fn("IssueSyncReactor.sweep")(function* (
    threadId?: ThreadId,
    requested?: ReadonlySet<CommandId>,
    changed?: IssueRef,
  ) {
    const threads = yield* projections.getThreadsWithIssues(threadId);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const groups = new Map<string, LinkEntry[]>();
    for (const thread of threads) {
      if (threadId === undefined && changed === undefined) {
        observedLinks.set(
          thread.id,
          new Set(
            (thread.issues ?? []).flatMap((link) =>
              link.linkId === undefined ? [] : [link.linkId],
            ),
          ),
        );
      }
      for (const link of thread.issues ?? []) {
        if (requested !== undefined && (link.linkId === undefined || !requested.has(link.linkId)))
          continue;
        const url = URL.parse(link.url);
        if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) continue;
        if (
          changed !== undefined &&
          (changed.projectId !== (link.projectId ?? thread.projectId) ||
            changed.repository.toLowerCase() !== link.repository.toLowerCase() ||
            changed.number !== link.number ||
            (changed.provider !== undefined && changed.provider !== link.provider) ||
            (changed.host !== undefined && changed.host.toLowerCase() !== url.host.toLowerCase()))
        )
          continue;
        const key = encodeSyncKey([
          link.projectId ?? thread.projectId,
          link.provider,
          link.repository.toLowerCase(),
          link.number,
          normalizeWorkItemLinkKey(link).url,
        ]);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }
    if (threadId === undefined && changed === undefined) {
      for (const map of [lastSyncedAt, retryAt]) {
        for (const key of map.keys()) if (!groups.has(key)) map.delete(key);
      }
      const activeThreads = new Set(threads.map((thread) => thread.id));
      for (const id of observedLinks.keys()) if (!activeThreads.has(id)) observedLinks.delete(id);
    }

    const forced = requested !== undefined || changed !== undefined;
    const dueBySource = new Map<string, Array<[string, LinkEntry[]]>>();
    const activeSources = new Set<string>();
    for (const [key, entries] of groups) {
      const first = entries[0]!;
      const sourceKey = encodeSourceKey([
        first.link.projectId ?? first.thread.projectId,
        first.link.provider,
        new URL(first.link.url).host.toLowerCase(),
      ]);
      activeSources.add(sourceKey);
      if (!forced) {
        if (now < (sourceRetryAt.get(sourceKey) ?? 0) || now < (retryAt.get(key) ?? 0)) continue;
        const last = lastSyncedAt.get(key);
        if (last === undefined && entries.every(({ link }) => link.state !== undefined)) {
          lastSyncedAt.set(key, now);
          continue;
        }
        const active = entries.some(
          ({ thread, link }) =>
            link.state !== "closed" &&
            thread.settledOverride !== "settled" &&
            thread.settledAt === null,
        );
        if (
          last !== undefined &&
          now - last < spreadInterval(key, active ? OPEN_SYNC_INTERVAL_MS : SLOW_SYNC_INTERVAL_MS)
        )
          continue;
      }
      const due = dueBySource.get(sourceKey) ?? [];
      due.push([key, entries]);
      dueBySource.set(sourceKey, due);
    }
    if (threadId === undefined && changed === undefined) {
      for (const key of sourceRetryAt.keys())
        if (!activeSources.has(key)) sourceRetryAt.delete(key);
    }
    const syncGroup = (sourceKey: string, [key, entries]: [string, LinkEntry[]]) =>
      Effect.gen(function* () {
        const first = entries[0]!;
        const url = new URL(first.link.url);
        const ref = {
          projectId: first.link.projectId ?? first.thread.projectId,
          provider: first.link.provider,
          repository: first.link.repository,
          number: first.link.number,
          host: url.host,
        };
        const detail = yield* issues.summary(ref);
        if (
          detail.projectId !== ref.projectId ||
          detail.provider !== ref.provider ||
          detail.repository.toLowerCase() !== ref.repository.toLowerCase() ||
          detail.number !== ref.number ||
          normalizeWorkItemLinkKey(detail).url !== normalizeWorkItemLinkKey(first.link).url
        ) {
          retryAt.set(key, now + SLOW_SYNC_INTERVAL_MS);
          return;
        }
        retryAt.delete(key);
        sourceRetryAt.delete(sourceKey);
        lastSyncedAt.set(key, now);
        for (const { thread, link } of entries) {
          if (link.title === detail.title && link.state === detail.state) continue;
          const uuid = yield* crypto.randomUUIDv4;
          yield* engine
            .dispatch({
              type: "thread.issue-link.sync",
              commandId: CommandId.make(`server:issue-sync:${thread.id}:${uuid}`),
              threadId: thread.id,
              projectId: thread.projectId,
              issue: { ...link, title: detail.title, state: detail.state },
              expectedIssue: link,
            })
            .pipe(Effect.catchCause(logSkipped({ threadId: thread.id, key })));
        }
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (isIssueProviderError(error.cause) && error.cause.reason === "rate-limited") {
              retryAt.set(key, error.cause.retryAt ?? now + OPEN_SYNC_INTERVAL_MS);
            } else if (
              error._tag === "IssueUnavailableError" &&
              (error.reason === "cli-missing" || error.reason === "cli-unauthenticated")
            ) {
              sourceRetryAt.set(sourceKey, now + OPEN_SYNC_INTERVAL_MS);
            } else {
              retryAt.set(key, now + SLOW_SYNC_INTERVAL_MS);
            }
          }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          if (now >= (retryAt.get(key) ?? 0) && now >= (sourceRetryAt.get(sourceKey) ?? 0))
            retryAt.set(key, now + OPEN_SYNC_INTERVAL_MS);
          return logSkipped({ key })(cause);
        }),
      );
    yield* Effect.forEach(
      dueBySource,
      ([sourceKey, due]) =>
        Effect.gen(function* () {
          if (forced) sourceRetryAt.delete(sourceKey);
          yield* Effect.forEach(
            due,
            (group) =>
              summaryReads.withPermit(
                Effect.suspend(() =>
                  now < (sourceRetryAt.get(sourceKey) ?? 0)
                    ? Effect.void
                    : syncGroup(sourceKey, group),
                ),
              ),
            { concurrency: due[0]?.[1][0]?.link.provider === "github" ? 25 : 1, discard: true },
          );
        }),
      { concurrency: 4, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((request: ThreadId | IssueRef | undefined) =>
    Effect.suspend(() => {
      const changed = typeof request === "object" ? request : undefined;
      const threadId = typeof request === "string" ? request : undefined;
      const requested = threadId === undefined ? undefined : requestedLinks.get(threadId);
      if (threadId !== undefined) requestedLinks.delete(threadId);
      return sweep(threadId, requested, changed);
    }).pipe(Effect.catchCause(logSkipped({ request }))),
  );
  const start: IssueSyncReactor["Service"]["start"] = Effect.fn("IssueSyncReactor.start")(
    function* () {
      yield* forkParked(Stream.runForEach(issues.subscribeRefreshes, worker.enqueue));
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type === "thread.archived" || event.type === "thread.deleted") {
            observedLinks.delete(event.threadId);
            return Effect.void;
          }
          if (event.type !== "thread.metadata-updated") return Effect.void;
          const previous = observedLinks.get(event.threadId);
          const current = new Set(
            (event.payload.issues ?? []).flatMap((issue) =>
              issue.linkId === undefined ? [] : [issue.linkId],
            ),
          );
          observedLinks.set(event.threadId, current);
          const added = [...current].filter((id) => !previous?.has(id));
          if (added.length === 0) return Effect.void;
          const pending = requestedLinks.get(event.threadId);
          if (pending !== undefined) {
            for (const id of added) pending.add(id);
            return Effect.void;
          }
          requestedLinks.set(event.threadId, new Set(added));
          return worker.enqueue(event.threadId);
        }).pipe(Effect.catchCause(logSkipped({}))),
      );
      yield* forkParked(
        worker
          .enqueue(undefined)
          .pipe(
            Effect.andThen(worker.drain),
            Effect.repeat(Schedule.spaced("1 minute")),
            Effect.asVoid,
          ),
      );
    },
  );
  return { start, drain: worker.drain } satisfies IssueSyncReactor["Service"];
});

export const layer = Layer.effect(IssueSyncReactor, make);
