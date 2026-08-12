import * as NodeCrypto from "node:crypto";

import type {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationActivityPageRequest,
  OrchestrationActivityPageResult,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import {
  ORCHESTRATION_ACTIVITY_PAGE_DEFAULT_SIZE,
  ORCHESTRATION_ACTIVITY_PAGE_MAX_PAYLOAD_BYTES,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  type PiExternalThreadSource,
  isPiExternalThreadId,
} from "../../piNative/PiExternalThreadSource.ts";
import {
  projectThreadActivityPageResult,
  projectThreadDetailSnapshot,
} from "../ActivityPayloadProjection.ts";
import type { ProjectionSnapshotQuery } from "./ProjectionSnapshotQuery.ts";

type ExternalSource = Option.Option<PiExternalThreadSource["Service"]>;

const missingExternalSource = () =>
  new OrchestrationGetSnapshotError({
    message: "External pi threads are unavailable",
  });

const compareOrdinalStrings = (left: string, right: string): number => {
  const leftCodePoints = left[Symbol.iterator]();
  const rightCodePoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftCodePoints.next();
    const rightPoint = rightCodePoints.next();
    if (leftPoint.done || rightPoint.done) {
      return leftPoint.done === rightPoint.done ? 0 : leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
};

export function getClientThreadDetailSnapshot(
  threadId: ThreadId,
  external: ExternalSource,
  internal: ProjectionSnapshotQuery["Service"],
): Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, OrchestrationGetSnapshotError> {
  if (isPiExternalThreadId(threadId)) {
    return Option.match(external, {
      onNone: () => Effect.fail(missingExternalSource()),
      onSome: (source) =>
        source.threadSnapshot(threadId).pipe(
          Effect.map((snapshot) => {
            const initial = externalPage(snapshot, {
              cursor: { kind: "initial" },
              pageSize: ORCHESTRATION_ACTIVITY_PAGE_DEFAULT_SIZE,
            });
            if (initial.kind === "cursor-expired") {
              return snapshot;
            }
            return {
              ...snapshot,
              thread: { ...snapshot.thread, activities: initial.activities },
              pageInfo: initial.pageInfo,
            };
          }),
          Effect.map(projectThreadDetailSnapshot),
          Effect.map(Option.some),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: `Failed to load external thread ${threadId}`,
                code: cause.code,
                cause,
              }),
          ),
        ),
    });
  }
  return internal.getThreadDetailPageSnapshot(threadId).pipe(
    Effect.map(Option.map(projectThreadDetailSnapshot)),
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load thread ${threadId}`,
          cause,
        }),
    ),
  );
}

/** Thread-scoped compatibility path for clients released before activity paging. */
export function getLegacyClientThreadDetailSnapshot(
  threadId: ThreadId,
  external: ExternalSource,
  internal: ProjectionSnapshotQuery["Service"],
): Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, OrchestrationGetSnapshotError> {
  if (isPiExternalThreadId(threadId)) {
    return Option.match(external, {
      onNone: () => Effect.fail(missingExternalSource()),
      onSome: (source) =>
        source.threadSnapshot(threadId).pipe(
          Effect.map(projectThreadDetailSnapshot),
          Effect.map(Option.some),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: `Failed to load external thread ${threadId}`,
                code: cause.code,
                cause,
              }),
          ),
        ),
    });
  }
  return internal.getThreadDetailSnapshot(threadId).pipe(
    Effect.map(Option.map(projectThreadDetailSnapshot)),
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load thread ${threadId}`,
          cause,
        }),
    ),
  );
}

function externalPage(
  snapshot: OrchestrationThreadDetailSnapshot,
  request: OrchestrationActivityPageRequest,
): OrchestrationActivityPageResult {
  const asOfSequence =
    request.cursor.kind === "initial" ? snapshot.snapshotSequence : request.cursor.asOfSequence;
  const position = (activity: OrchestrationThreadActivity) => ({
    sequence: activity.sequence ?? null,
    createdAt: activity.createdAt,
    activityId: activity.id,
  });
  const all = snapshot.thread.activities
    .filter((activity) => activity.sequence === undefined || activity.sequence <= asOfSequence)
    .toSorted(
      (left, right) =>
        (left.sequence === undefined ? 0 : 1) - (right.sequence === undefined ? 0 : 1) ||
        (left.sequence ?? 0) - (right.sequence ?? 0) ||
        compareOrdinalStrings(left.createdAt, right.createdAt) ||
        compareOrdinalStrings(left.id, right.id),
    );
  const retentionFloor = all[0]
    ? { kind: "oldest-available" as const, position: position(all[0]) }
    : { kind: "empty" as const };
  // Persisted Pi activities are unsequenced. Freezing the ordered prefix
  // through each anchor permits newer appends while expiring a cursor if an
  // older row is inserted, removed, or reordered between page requests.
  const historyRevisionAt = (index: number) =>
    NodeCrypto.createHash("sha256")
      .update(JSON.stringify(all.slice(0, index + 1).map(position)))
      .digest("hex");
  let end = all.length;
  const cursor = request.cursor;
  if (cursor.kind === "before") {
    const retentionFloorChanged =
      cursor.retentionFloor.kind !== retentionFloor.kind ||
      (cursor.retentionFloor.kind === "oldest-available" &&
        retentionFloor.kind === "oldest-available" &&
        (cursor.retentionFloor.position.activityId !== retentionFloor.position.activityId ||
          cursor.retentionFloor.position.sequence !== retentionFloor.position.sequence ||
          cursor.retentionFloor.position.createdAt !== retentionFloor.position.createdAt));
    if (asOfSequence > snapshot.snapshotSequence || retentionFloorChanged) {
      return { kind: "cursor-expired", asOfSequence, retentionFloor };
    }
    const index = all.findIndex((activity) => {
      const candidate = position(activity);
      return (
        candidate.activityId === cursor.position.activityId &&
        candidate.sequence === cursor.position.sequence &&
        candidate.createdAt === cursor.position.createdAt
      );
    });
    if (index < 0) {
      return { kind: "cursor-expired", asOfSequence, retentionFloor };
    }
    if (cursor.historyRevision !== historyRevisionAt(index)) {
      return { kind: "cursor-expired", asOfSequence, retentionFloor };
    }
    end = index;
  }

  const candidates = all.slice(Math.max(0, end - request.pageSize), end).reverse();
  let payloadBytes = 0;
  const omittedPayloads: Array<{
    activityId: (typeof candidates)[number]["id"];
    originalPayloadBytes: number;
    limitBytes: number;
    reason: "page-payload-byte-limit";
  }> = [];
  const selected: Array<(typeof candidates)[number]> = [];
  for (const activity of candidates) {
    const bytes = Buffer.byteLength(JSON.stringify(activity.payload) ?? "null", "utf8");
    if (payloadBytes + bytes <= ORCHESTRATION_ACTIVITY_PAGE_MAX_PAYLOAD_BYTES) {
      payloadBytes += bytes;
      selected.push(activity);
      continue;
    }
    omittedPayloads.push({
      activityId: activity.id,
      originalPayloadBytes: bytes,
      limitBytes: ORCHESTRATION_ACTIVITY_PAGE_MAX_PAYLOAD_BYTES,
      reason: "page-payload-byte-limit",
    });
    selected.push({
      ...activity,
      payload: {
        kind: "omitted" as const,
        reason: "page-payload-byte-limit" as const,
        originalPayloadBytes: bytes,
        limitBytes: ORCHESTRATION_ACTIVITY_PAGE_MAX_PAYLOAD_BYTES,
      },
    });
    break;
  }

  const activities = selected.reverse();
  const oldest = activities[0];
  const oldestIndex =
    oldest === undefined ? -1 : all.findIndex((activity) => activity.id === oldest.id);
  return {
    kind: "page",
    activities,
    pageInfo: {
      asOfSequence,
      nextCursor:
        oldest !== undefined && end - selected.length > 0
          ? {
              kind: "before",
              asOfSequence,
              position: position(oldest),
              retentionFloor,
              historyRevision: historyRevisionAt(oldestIndex),
            }
          : null,
      retentionFloor,
      limits: {
        pageSize: request.pageSize,
        payloadBytes: ORCHESTRATION_ACTIVITY_PAGE_MAX_PAYLOAD_BYTES,
      },
      payloadBytes,
      omittedPayloads,
    },
  };
}

export function getClientThreadActivityPage(
  threadId: ThreadId,
  request: OrchestrationActivityPageRequest,
  external: ExternalSource,
  internal: ProjectionSnapshotQuery["Service"],
): Effect.Effect<Option.Option<OrchestrationActivityPageResult>, OrchestrationGetSnapshotError> {
  if (!isPiExternalThreadId(threadId)) {
    return internal.getThreadActivityPage(threadId, request).pipe(
      Effect.map(Option.map(projectThreadActivityPageResult)),
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: `Failed to load activities for ${threadId}`,
            cause,
          }),
      ),
    );
  }
  return Option.match(external, {
    onNone: () => Effect.fail(missingExternalSource()),
    onSome: (source) =>
      source.threadSnapshot(threadId).pipe(
        Effect.map((snapshot) =>
          Option.some(projectThreadActivityPageResult(externalPage(snapshot, request))),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: `Failed to load external activities for ${threadId}`,
              code: cause.code,
              cause,
            }),
        ),
      ),
  });
}

export function getExternalThreadSubscription(
  input: OrchestrationSubscribeThreadInput,
  external: ExternalSource,
): Stream.Stream<OrchestrationThreadStreamItem, OrchestrationGetSnapshotError> | null {
  if (!isPiExternalThreadId(input.threadId)) return null;
  return Option.match(external, {
    onNone: () => Stream.fail(missingExternalSource()),
    onSome: (source) =>
      source.subscribeThread(input).pipe(
        Stream.map((item) => {
          if (item.kind !== "snapshot") return item;
          const initial = externalPage(item.snapshot, {
            cursor: { kind: "initial" },
            pageSize: ORCHESTRATION_ACTIVITY_PAGE_DEFAULT_SIZE,
          });
          return initial.kind === "cursor-expired"
            ? item
            : {
                ...item,
                snapshot: projectThreadDetailSnapshot({
                  ...item.snapshot,
                  thread: { ...item.snapshot.thread, activities: initial.activities },
                  pageInfo: initial.pageInfo,
                }),
              };
        }),
        // The code rides along so clients can tell "this thread is gone" apart
        // from a transient failure and back off instead of hot-retrying.
        Stream.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: `Failed to subscribe to external thread ${input.threadId}`,
              code: cause.code,
              cause,
            }),
        ),
      ),
  });
}

export function getExternalThreadDispatch(
  command: ClientOrchestrationCommand,
  external: ExternalSource,
): Effect.Effect<DispatchResult, OrchestrationDispatchCommandError> | null {
  if (!("threadId" in command) || !isPiExternalThreadId(command.threadId)) return null;
  return Option.match(external, {
    onNone: () =>
      Effect.fail(
        new OrchestrationDispatchCommandError({
          message: "External pi threads are unavailable",
        }),
      ),
    onSome: (source) =>
      source.dispatch(command).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Failed to dispatch external pi command",
              code: cause.code,
              cause,
            }),
        ),
      ),
  });
}
