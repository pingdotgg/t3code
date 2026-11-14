import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadCheckpointSummaries } from "./threadCheckpoints.ts";

function checkpoint(
  run: string,
  overrides: Partial<OrchestrationV2Checkpoint> = {},
): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(`checkpoint-${run}`),
    threadId: ThreadId.make("thread"),
    scopeId: CheckpointScopeId.make("scope"),
    runId: RunId.make(run),
    nodeId: NodeId.make(`node-${run}`),
    parentCheckpointId: null,
    ordinalWithinScope: 1,
    appRunOrdinal: 1,
    ref: CheckpointRef.make(`ref-${run}`),
    status: "ready",
    files: [],
    capturedAt: DateTime.makeUnsafe("2026-10-26T09:30:00.123+11:00"),
    ...overrides,
  };
}

function message(
  run: string,
  id: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId: ThreadId.make("thread"),
    runId: RunId.make(run),
    nodeId: null,
    role: "assistant",
    text: "Answer",
    attachments: [],
    streaming: false,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: DateTime.makeUnsafe("2026-10-26T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-26T00:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveThreadCheckpointSummaries", () => {
  it("preserves checkpoint order, status, file references and ISO dates while filtering null keys", () => {
    const files = Object.freeze([
      { path: "src/one.ts", kind: "modified", additions: 10, deletions: 2 },
    ]);
    const eligible = ["stale", "error", "missing", "ready"].map((status, index) =>
      checkpoint(`run-${index}`, {
        status: status as OrchestrationV2Checkpoint["status"],
        appRunOrdinal: 4 - index,
        files,
      }),
    );
    const checkpoints = Object.freeze([
      checkpoint("no-ordinal", { appRunOrdinal: null }),
      ...eligible.slice(0, 2),
      checkpoint("no-run", { runId: null }),
      ...eligible.slice(2),
    ]);
    const summaries = deriveThreadCheckpointSummaries({ checkpoints, messages: [] });

    expect(summaries).toEqual(
      eligible.map((entry) => ({
        checkpointId: entry.id,
        scopeId: entry.scopeId,
        runId: entry.runId,
        checkpointTurnCount: entry.appRunOrdinal,
        checkpointRef: entry.ref,
        status: entry.status,
        files,
        assistantMessageId: null,
        completedAt: "2026-10-25T22:30:00.123Z",
      })),
    );
    for (const summary of summaries) expect(summary.files).toBe(files);
  });

  it("selects the last assistant in array order across interleaved runs and duplicate checkpoints", () => {
    const newer = DateTime.makeUnsafe("2026-10-26T01:00:00.000Z");
    const messages = Object.freeze([
      message("a", "newer-timestamp", { createdAt: newer, updatedAt: newer }),
      message("b", "b-first"),
      message("a", "last-in-array"),
      message("b", "b-last"),
      message("a", "user-tail", { role: "user" }),
      message("a", "system-tail", { role: "system" }),
      message("a", "unscoped-tail", { runId: null }),
    ]);
    const summaries = deriveThreadCheckpointSummaries({
      checkpoints: [checkpoint("b"), checkpoint("a"), checkpoint("b", { appRunOrdinal: 3 })],
      messages,
    });

    expect(summaries.map((summary) => summary.assistantMessageId)).toEqual([
      "b-last",
      "last-in-array",
      "b-last",
    ]);
    expect(messages.map((entry) => entry.id)).toEqual([
      "newer-timestamp",
      "b-first",
      "last-in-array",
      "b-last",
      "user-tail",
      "system-tail",
      "unscoped-tail",
    ]);
  });

  it("returns null for absent runs and runs containing only user or system messages", () => {
    const summaries = deriveThreadCheckpointSummaries({
      checkpoints: [checkpoint("absent"), checkpoint("user-only"), checkpoint("system-only")],
      messages: [
        message("other", "other-assistant"),
        message("user-only", "user", { role: "user" }),
        message("system-only", "system", { role: "system" }),
      ],
    });
    expect(summaries.map((summary) => summary.assistantMessageId)).toEqual([null, null, null]);
  });

  it.each([null, undefined])("does not fall back past a last assistant with ID %s", (id) => {
    const { id: _id, ...withoutId } = message("a", "last");
    // Preserve the runtime fallback even for legacy objects outside the decoded schema.
    const last = (
      id === undefined ? withoutId : { ...withoutId, id }
    ) as OrchestrationV2ConversationMessage;
    const summaries = deriveThreadCheckpointSummaries({
      checkpoints: [checkpoint("a"), checkpoint("a")],
      messages: [message("a", "earlier-valid-id"), last],
    });
    expect(summaries.map((summary) => summary.assistantMessageId)).toEqual([null, null]);
  });

  it.each([
    { checkpoints: [] },
    {
      checkpoints: [
        checkpoint("no-ordinal", { appRunOrdinal: null }),
        checkpoint("no-run", { runId: null }),
      ],
    },
  ])("does not read messages with no eligible checkpoints: %j", ({ checkpoints }) => {
    expect(
      deriveThreadCheckpointSummaries({
        checkpoints,
        get messages(): ReadonlyArray<OrchestrationV2ConversationMessage> {
          throw new Error("Ineligible checkpoints must not read message history");
        },
      }),
    ).toEqual([]);
  });

  it("rebuilds associations for message and checkpoint replacements without retaining stale IDs", () => {
    const original = message("a", "original");
    const checkpoints = [checkpoint("a")];
    const first = deriveThreadCheckpointSummaries({ checkpoints, messages: [original] });
    expect(first[0]?.assistantMessageId).toBe("original");
    expect(
      deriveThreadCheckpointSummaries({
        checkpoints,
        messages: [original, message("a", "replacement")],
      })[0]?.assistantMessageId,
    ).toBe("replacement");
    expect(
      deriveThreadCheckpointSummaries({ checkpoints, messages: [] })[0]?.assistantMessageId,
    ).toBeNull();
    expect(
      deriveThreadCheckpointSummaries({
        checkpoints: [checkpoint("b")],
        messages: [original, message("b", "new-checkpoint")],
      })[0]?.assistantMessageId,
    ).toBe("new-checkpoint");
    expect(first[0]?.assistantMessageId).toBe("original");
  });

  it("stops at the newest requested assistant when only tail checkpoints are needed", () => {
    const history = Array.from({ length: 1_000 }, (_, index) => ({
      ...message(`old-${index}`, `old-${index}`),
      get runId(): RunId {
        throw new Error("Tail checkpoints must not traverse older history");
      },
    }));
    const summaries = deriveThreadCheckpointSummaries({
      checkpoints: [checkpoint("latest"), checkpoint("latest")],
      messages: [...history, message("latest", "latest-answer")],
    });
    expect(summaries.map((summary) => summary.assistantMessageId)).toEqual([
      "latest-answer",
      "latest-answer",
    ]);
  });

  it("does not index assistant IDs from unrelated runs", () => {
    const unrelated = Array.from({ length: 1_000 }, (_, index) => ({
      ...message(`other-${index}`, `other-${index}`),
      get id(): MessageId {
        throw new Error("Unrequested runs must not be indexed");
      },
    }));
    const summaries = deriveThreadCheckpointSummaries({
      checkpoints: [checkpoint("requested")],
      messages: [message("requested", "requested-answer"), ...unrelated],
    });
    expect(summaries[0]?.assistantMessageId).toBe("requested-answer");
  });

  it.each([20, 100, 1_000])(
    "visits message run metadata at most once for %i eligible checkpoints",
    (count) => {
      let metadataVisits = 0;
      const messages = Array.from({ length: count }, (_, index) => [
        message(`run-${index}`, `user-${index}`, { role: "user" }),
        message(`run-${index}`, `assistant-${index}`),
      ])
        .flat()
        .concat(message("active-run", "active-assistant"))
        .map((entry) => ({
          ...entry,
          get runId() {
            metadataVisits++;
            return entry.runId;
          },
          get text(): string {
            throw new Error("Checkpoint summaries must not read message bodies");
          },
        }));
      const summaries = deriveThreadCheckpointSummaries({
        checkpoints: Array.from({ length: count }, (_, index) => checkpoint(`run-${index}`)),
        messages,
      });

      expect(summaries.map((summary) => summary.assistantMessageId)).toEqual(
        Array.from({ length: count }, (_, index) => `assistant-${index}`),
      );
      expect(metadataVisits).toBeLessThanOrEqual(messages.length);
    },
  );
});
