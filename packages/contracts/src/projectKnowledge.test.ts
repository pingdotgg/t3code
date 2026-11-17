import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ProjectKnowledgeDelivery,
  ProjectKnowledgeListInput,
  ProjectKnowledgeListResult,
  ProjectKnowledgeMutation,
  ProjectKnowledgeStatus,
} from "./projectKnowledge.ts";

const decodeDelivery = Schema.decodeUnknownSync(ProjectKnowledgeDelivery);

const decodeList = Schema.decodeUnknownSync(ProjectKnowledgeListResult);
const encodeList = Schema.encodeSync(ProjectKnowledgeListResult);
const decodeListInput = Schema.decodeUnknownSync(ProjectKnowledgeListInput);
const decodeMutation = Schema.decodeUnknownSync(ProjectKnowledgeMutation);
const decodeStatus = Schema.decodeUnknownSync(ProjectKnowledgeStatus);
const encodeStatus = Schema.encodeSync(ProjectKnowledgeStatus);

const fact = (origin: Record<string, unknown>) => ({
  id: "fact-1",
  origin,
  projectId: "project-1",
  kind: "decision",
  revision: 1,
  trust: 0.5,
  retrievalCount: 0,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  content: "Cache keys include tenant IDs.",
  entities: [],
  tags: [],
  sources: [],
  status: "saved",
  forgottenAt: null,
});

describe("KnowledgeOrigin", () => {
  it("decodes an origin kind from a newer server as unknown instead of failing the list", () => {
    const listed = decodeList({
      facts: [fact({ kind: "user" }), fact({ kind: "reviewer-bot", reviewer: "x" })],
      nextCursor: null,
    });
    expect(listed.facts.map((item) => item.origin)).toEqual([
      { kind: "user" },
      { kind: "unknown", originKind: "reviewer-bot" },
    ]);
    // Re-encoding keeps the original kind, so a store round trip does not relabel it.
    expect(encodeList(listed).facts[1]?.origin).toEqual({ kind: "reviewer-bot" });
  });

  it("still fails a known origin kind whose payload is broken", () => {
    expect(() =>
      decodeList({ facts: [fact({ kind: "assisted", threadId: "t" })], nextCursor: null }),
    ).toThrow();
  });
});

describe("fact lifecycle", () => {
  it("encodes and decodes saved directly", () => {
    const list = { facts: [fact({ kind: "user" })], nextCursor: null };
    expect(encodeList(decodeList(list)).facts[0]?.status).toBe("saved");
  });

  it.each(["proposed", "confirmed"])("rejects %s as a current status", (status) => {
    expect(() =>
      decodeList({ facts: [{ ...fact({ kind: "user" }), status }], nextCursor: null }),
    ).toThrow();
    expect(() => decodeListInput({ projectId: "project-1", status })).toThrow();
  });

  it("has no confirm mutation", () => {
    expect(() =>
      decodeMutation({
        action: "confirm",
        commandId: "command-1",
        projectId: "project-1",
        factId: "fact-1",
        expectedRevision: 1,
      }),
    ).toThrow();
  });

  it("reports saved counts and runs without pending counters", () => {
    const status = {
      counts: { saved: 2, superseded: 1, forgotten: 0 },
      trustBands: { low: 0, guarded: 0, steady: 2, high: 0 },
      recallThreshold: 0.3,
      belowRecallThreshold: 0,
      retrievals: 0,
      feedback: { helpful: 0, unhelpful: 0 },
      unavailableSources: 0,
      unavailableSourcesCoverage: "complete",
      assistedLearning: {
        lastRun: {
          threadId: "thread-1",
          runId: "run-1",
          runOutcome: "completed",
          result: "ran",
          reason: null,
          saved: 2,
          at: "2026-10-22T00:00:00.000Z",
        },
      },
    };
    expect(encodeStatus(decodeStatus(status))).toEqual(status);
    expect(() =>
      decodeStatus({
        ...status,
        counts: { proposed: 1, confirmed: 1, superseded: 1, forgotten: 0 },
      }),
    ).toThrow();
  });
});

const oldDelivery = {
  attemptId: "attempt",
  runId: "run",
  threadId: "thread",
  messageId: "message",
  projectId: "project",
  providerInstanceId: "provider",
  status: "sent",
  items: [],
  omissions: [],
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
it("decodes old delivery receipts without budget assumptions", () => {
  expect(decodeDelivery(oldDelivery)).toEqual(oldDelivery);
});
it.each(["over_budget", "source_unavailable", "stale_revision", "not_permitted", "recall_failed"])(
  "decodes omission %s",
  (reason) => {
    const omissions = [{ contextId: "source", label: "Source", reason }];
    expect(decodeDelivery({ ...oldDelivery, omissions }).omissions).toEqual(omissions);
  },
);
