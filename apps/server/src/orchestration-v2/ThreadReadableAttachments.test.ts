import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ProjectionStoreThreadNotFoundError,
  type ProjectionRecordFilter,
  type ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";
import { readThreadReadableAttachmentIds } from "./ThreadReadableAttachments.ts";

interface FakeRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
}
interface FakeItem {
  readonly type: string;
  readonly runId: string | null;
  readonly attachments?: ReadonlyArray<{ readonly id: string }>;
  readonly inputIntent?: string;
  readonly questionAnswer?: {
    readonly attachmentsByQuestionId: Record<string, ReadonlyArray<{ readonly id: string }>>;
  };
}
interface FakeThread {
  readonly forkedFrom: {
    readonly type: "run";
    readonly threadId: string;
    readonly runId: string;
  } | null;
  readonly sideChat?: boolean;
  readonly runs: ReadonlyArray<FakeRun>;
  readonly items: ReadonlyArray<FakeItem>;
}

// Stored upload IDs start with their owner thread; each label's owner is its first word.
const labels: Array<string> = [];
const uploadId = (label: string) => {
  if (!labels.includes(label)) labels.push(label);
  const serial = String(labels.indexOf(label) + 1).padStart(12, "0");
  return `${label.split("-")[0]}-00000000-0000-4000-8000-${serial}`;
};
const labelOf = (id: string) => labels.find((label) => uploadId(label) === id) ?? id;
const message = (runId: string | null, label: string, inputIntent = "new_turn"): FakeItem => ({
  type: "user_message",
  runId,
  inputIntent,
  attachments: [{ id: uploadId(label) }],
});
const answer = (runId: string, label: string): FakeItem => ({
  type: "user_input_request",
  runId,
  questionAnswer: { attachmentsByQuestionId: { file: [{ id: uploadId(label) }] } },
});
const runs = (...statuses: ReadonlyArray<string>) =>
  statuses.map((status, index) => ({ id: `run-${index + 1}`, ordinal: index + 1, status }));

/** Applies the same type and run filters the projection store applies in SQL. */
function fakeStore(
  threads: Record<string, FakeThread>,
): Pick<ProjectionStoreV2Shape, "getThreadRecords"> {
  const getThreadRecords = (
    threadId: ThreadId,
    _fields: unknown,
    filter?: ProjectionRecordFilter,
  ) => {
    const thread = threads[threadId];
    if (thread === undefined)
      return Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }));
    const runIds = filter?.turnItemRunIds;
    return Effect.succeed({
      thread: {
        id: threadId,
        forkedFrom: thread.forkedFrom,
        lineage: { sideChat: thread.sideChat },
      },
      runs: thread.runs,
      attempts: [],
      turnItems: thread.items.filter(
        (item) =>
          (filter?.turnItemTypes === undefined ||
            filter.turnItemTypes.some((type) => type === item.type)) &&
          (runIds === undefined || runIds.some((runId) => runId === item.runId)),
      ),
    });
  };
  return {
    getThreadRecords: getThreadRecords as unknown as ProjectionStoreV2Shape["getThreadRecords"],
  };
}

const fork = (threadId: string, runId: string) => ({ type: "run" as const, threadId, runId });

it.effect("reads uploads from the history the thread's agent was given", () =>
  Effect.gen(function* () {
    const store = fakeStore({
      source: {
        forkedFrom: null,
        runs: runs("completed", "rolled_back", "completed", "completed", "cancelled"),
        items: [
          message("run-1", "source-before"),
          answer("run-1", "source-answer"),
          message("run-2", "source-rolled-back"),
          message("run-3", "source-at-fork"),
          message("run-4", "source-after-fork"),
          answer("run-4", "source-answer-after-fork"),
          message("run-5", "source-cancelled-queue", "queued_turn"),
        ],
      },
      fork: {
        forkedFrom: fork("source", "run-3"),
        runs: runs("completed", "completed"),
        items: [message("run-1", "fork-own"), message("run-2", "fork-after-nested-fork")],
      },
      nested: {
        forkedFrom: fork("fork", "run-1"),
        runs: runs("completed"),
        items: [message("run-1", "nested-own")],
      },
      side: {
        forkedFrom: fork("source", "run-3"),
        sideChat: true,
        runs: runs("completed"),
        items: [message("run-1", "side-own")],
      },
      sibling: {
        forkedFrom: null,
        runs: runs("completed"),
        // A client named the source thread's stored upload in this unrelated thread.
        items: [message("run-1", "sibling-own"), message("run-1", "source-before")],
      },
      orphan: { forkedFrom: fork("deleted", "run-1"), runs: [], items: [] },
      "missing-run": { forkedFrom: fork("source", "run-9"), runs: [], items: [] },
    });
    const readable = (threadId: string) =>
      readThreadReadableAttachmentIds(store, ThreadId.make(threadId)).pipe(
        Effect.map((ids) => ids.map(labelOf).toSorted()),
      );

    assert.deepEqual(yield* readable("source"), [
      "source-after-fork",
      "source-answer",
      "source-answer-after-fork",
      "source-at-fork",
      "source-before",
    ]);
    assert.deepEqual(yield* readable("fork"), [
      "fork-after-nested-fork",
      "fork-own",
      "source-answer",
      "source-at-fork",
      "source-before",
    ]);
    assert.deepEqual(yield* readable("nested"), [
      "fork-own",
      "nested-own",
      "source-answer",
      "source-at-fork",
      "source-before",
    ]);
    // Side chats show only their own rows, so they inherit no uploads.
    assert.deepEqual(yield* readable("side"), ["side-own"]);
    assert.deepEqual(yield* readable("sibling"), ["sibling-own"]);
    assert.deepEqual(yield* readable("orphan"), []);
    assert.deepEqual(yield* readable("missing-run"), []);
  }),
);
