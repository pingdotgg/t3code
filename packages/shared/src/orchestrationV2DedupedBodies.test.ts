import {
  CheckpointId,
  CheckpointScopeId,
  MessageId,
  NodeId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundedSnapshotProjection,
  omitLocalVisibleTurnItems,
} from "./orchestrationV2BoundedSnapshot.ts";
import {
  dedupeSnapshotBodies,
  restoreSnapshotBodies,
  restoreSubagentBodies,
} from "./orchestrationV2DedupedBodies.ts";

const THREAD = ThreadId.make("thread:bodies");
const PARENT = ThreadId.make("thread:bodies-parent");
const at = "2026-10-01T00:00:00.000Z";

function item(id: string, fields: Record<string, unknown>, threadId = THREAD) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
}

const message = (id: string, role: "user" | "assistant", text: string) => ({
  id: MessageId.make(id),
  threadId: THREAD,
  runId: null,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdBy: role === "user" ? "user" : "agent",
  creationSource: role === "user" ? "web" : "provider",
  createdAt: at,
  updatedAt: at,
});
const files = [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }];
const subagent = {
  id: NodeId.make("node:task"),
  prompt: "do the task",
  result: "final result",
} as Partial<OrchestrationV2Subagent>;

const userMessage = (id: string, messageId: string, text: string) =>
  item(id, {
    type: "user_message",
    messageId: MessageId.make(messageId),
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  });
const assistantMessage = (id: string, messageId: string, text: string, threadId = THREAD) =>
  item(
    id,
    { type: "assistant_message", messageId: MessageId.make(messageId), text, streaming: false },
    threadId,
  );
const checkpoint = (id: string, checkpointId: string, itemFiles: typeof files) =>
  item(id, {
    type: "checkpoint",
    checkpointId: CheckpointId.make(checkpointId),
    scopeId: CheckpointScopeId.make("scope"),
    files: itemFiles,
  });

const local: OrchestrationV2TurnItem[] = [
  userMessage("user", "m-user", "hello"),
  assistantMessage("assistant", "m-assistant", "hi there"),
  assistantMessage("stale", "m-stale", "older text"),
  userMessage("empty", "m-empty", ""),
  checkpoint("checkpoint", "c-1", files),
  checkpoint("orphan-checkpoint", "c-missing", files),
  checkpoint("no-files", "c-empty", []),
  item("task", {
    type: "subagent",
    subagentId: subagent.id,
    origin: "app_owned",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: null,
    prompt: "do the task",
    result: "partial result",
  }),
];
// A fork's inherited row may name a message id this thread also has; its record lives elsewhere.
const inherited = assistantMessage("inherited", "m-assistant", "hi there", PARENT);

const projection = {
  thread: { id: THREAD },
  messages: [
    message("m-user", "user", "hello"),
    message("m-assistant", "assistant", "hi there"),
    message("m-stale", "assistant", "newer text"),
    message("m-empty", "user", ""),
  ],
  checkpoints: [
    { id: CheckpointId.make("c-1"), files },
    { id: CheckpointId.make("c-empty"), files: [] },
  ],
  subagents: [subagent],
  turnItems: local,
  visibleTurnItems: [
    {
      position: 0,
      visibility: "inherited",
      sourceThreadId: PARENT,
      sourceItemId: inherited.id,
      item: inherited,
    },
    ...local.map((value, index) => ({
      position: index + 1,
      visibility: "local",
      sourceThreadId: THREAD,
      sourceItemId: value.id,
      item: value,
    })),
  ],
} as unknown as OrchestrationV2ThreadProjection;

function markers(value: OrchestrationV2ThreadProjection) {
  return Object.fromEntries(
    value.visibleTurnItems.flatMap(({ item }) => {
      const marked = ["textOmitted", "filesOmitted", "promptOmitted", "resultOmitted"].filter(
        (key) => key in item,
      );
      return marked.length === 0 ? [] : [[String(item.id), marked]];
    }),
  );
}

describe("deduped snapshot bodies", () => {
  it("blanks only bodies equal to a record and restores them exactly", () => {
    const deduped = dedupeSnapshotBodies(projection);

    expect(markers(deduped)).toEqual({
      user: ["textOmitted"],
      assistant: ["textOmitted"],
      checkpoint: ["filesOmitted"],
      task: ["promptOmitted"],
    });
    expect(restoreSnapshotBodies(deduped)).toEqual(projection);
    expect(restoreSnapshotBodies(projection)).toBe(projection);
  });

  it("keeps items shared with turnItems as one object, so the compact snapshot still applies", () => {
    const compact = omitLocalVisibleTurnItems(dedupeSnapshotBodies(projection));

    expect(compact?.turnItems).toEqual([]);
    expect(
      boundedSnapshotProjection({ projection: compact!, turnItemsOmitLocalVisible: true }),
    ).toEqual(projection);
  });

  it("does not restore a field from a subagent record whose field is itself still marked", () => {
    const marked = {
      prompt: "",
      result: null,
      promptOmitted: true as const,
      resultOmitted: true as const,
    };
    const previous = { prompt: "", result: "done", promptOmitted: true as const };

    expect(restoreSubagentBodies(marked, previous)).toEqual({
      prompt: "",
      result: "done",
      promptOmitted: true,
    });
  });
});
