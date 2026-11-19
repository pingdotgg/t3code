import {
  EnvironmentId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ProjectFactHistoryEntry,
  type ProjectKnowledgeDeliveries,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  deliveredKnowledgeNotes,
  deliveredKnowledgeSnapshot,
  KNOWLEDGE_DELIVERY_OMISSION_LABEL,
  projectFactHistoryLabel,
  projectFactTrustPoints,
} from "./index.ts";

const delivery = (
  attemptId: string,
  status: ProjectKnowledgeDeliveries["deliveries"][number]["status"],
  text: string,
): ProjectKnowledgeDeliveries["deliveries"][number] => ({
  attemptId: RunAttemptId.make(attemptId),
  runId: RunId.make("run"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  projectId: ProjectId.make("project"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  status,
  items: [
    {
      contextId: "knowledge",
      label: "Knowledge",
      context: {
        environmentId: EnvironmentId.make("environment"),
        projectId: ProjectId.make("project"),
        selections: [{ kind: "fact", factId: ProjectFactId.make("fact"), revision: 1 }],
        maxBytes: 48000,
      },
      text,
      current: "changed",
    },
  ],
  omissions: [],
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
});

it("shows the copy the provider accepted, even when a later failover attempt was not confirmed", () => {
  const snapshot = deliveredKnowledgeSnapshot(
    {
      deliveries: [
        delivery("first", "uncertain", "first copy"),
        delivery("failover", "sent", "failover copy"),
        delivery("retry", "prepared", "retry copy"),
      ],
    },
    "knowledge",
  );
  expect(snapshot?.item?.text).toBe("failover copy");
  expect(deliveredKnowledgeNotes(snapshot!)).toEqual([
    "Prepared for 3 provider attempts.",
    "This knowledge has changed since it was sent.",
  ]);
  expect(deliveredKnowledgeSnapshot({ deliveries: [] }, "knowledge")).toBeNull();
});

it("shows why an attached reference was omitted when nothing was delivered", () => {
  const omission = {
    contextId: "knowledge",
    label: "Knowledge",
    reason: "not_referenced" as const,
  };
  const snapshot = deliveredKnowledgeSnapshot(
    {
      deliveries: [{ ...delivery("omitted", "sent", ""), items: [], omissions: [omission] }],
    },
    "knowledge",
  );
  expect(snapshot).toEqual({ status: "sent", item: null, omission, attempts: 1 });
  expect(deliveredKnowledgeNotes(snapshot!)).toEqual([]);
  expect(KNOWLEDGE_DELIVERY_OMISSION_LABEL[omission.reason]).toBe("not referenced in the message");
  expect(
    deliveredKnowledgeSnapshot(
      {
        deliveries: [
          delivery("included", "sent", "earlier copy"),
          { ...delivery("omitted", "sent", ""), items: [], omissions: [omission] },
          delivery("retry", "prepared", "retry copy"),
        ],
      },
      "knowledge",
    ),
  ).toEqual({ status: "sent", item: null, omission, attempts: 3 });
});

const historyEntry = (
  sequence: number,
  event: ProjectFactHistoryEntry["event"],
  trustBefore: number | null,
  trustAfter: number,
  helpful: boolean | null = null,
): ProjectFactHistoryEntry => ({
  sequence,
  event,
  revision: sequence,
  actor: { kind: "user" },
  at: "2026-10-22T00:00:00.000Z",
  contentDigest: null,
  content: null,
  sources: [],
  trustBefore,
  trustAfter,
  helpful,
  relatedFactId: null,
  sourceUnavailable: null,
});

it("traces trust from before the first recorded event through each feedback", () => {
  const history = [
    historyEntry(1, "baseline", null, 0.5),
    historyEntry(2, "feedback", 0.5, 0.55, true),
    historyEntry(3, "feedback", 0.55, 0.45, false),
  ];
  expect(projectFactTrustPoints(history)).toEqual([0.5, 0.55, 0.45]);
  expect(projectFactTrustPoints(history.slice(1))).toEqual([0.5, 0.55, 0.45]);
  expect(history.map(projectFactHistoryLabel)).toEqual([
    "History begins at revision 1",
    "Marked helpful",
    "Marked unhelpful",
  ]);
});

it("labels memory actions carried by legacy-compatible history events", () => {
  const edited = historyEntry(2, "edited", null, 0.5);
  expect(projectFactHistoryLabel(edited)).toBe("Edited to revision 2");
  expect(projectFactHistoryLabel({ ...edited, memoryAction: "curated" })).toBe(
    "Set aside by the memory curator",
  );
  expect(
    projectFactHistoryLabel({
      ...edited,
      event: "superseded",
      memoryAction: "curated",
      relatedFactId: ProjectFactId.make("replacement"),
    }),
  ).toBe("Superseded by the memory curator");
  expect(projectFactHistoryLabel({ ...edited, memoryAction: "restored" })).toBe(
    "Restored to recall",
  );
});
