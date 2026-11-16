import { describe, expect, it } from "vite-plus/test";

import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { fyiCarrierRuns, fyiRunIds, resolveFyiMarker } from "./fyiMarker.ts";

describe("resolveFyiMarker", () => {
  const at = DateTime.makeUnsafe("2026-11-16T05:42:00.000Z");
  const runId = RunId.make("run:carrier");
  const nodeId = NodeId.make("node:carrier");
  const fyi = (bound: boolean): OrchestrationV2TurnItem => ({
    id: TurnItemId.make("item:fyi"),
    threadId: ThreadId.make("thread:fyi"),
    runId: bound ? runId : null,
    nodeId: bound ? nodeId : null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: bound ? "completed" : "pending",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    type: "user_message",
    messageId: MessageId.make("message:fyi"),
    createdBy: "agent",
    creationSource: "mcp",
    inputIntent: "steer",
    text: "main moved",
    attachments: [],
    fyi: true,
  });
  const run = (status: OrchestrationV2Run["status"]) => ({ status, rootNodeId: nodeId });

  it.each([
    ["runless", fyi(false), undefined, "FYI · waiting", "It started no turn."],
    ["carried by a running turn", fyi(true), run("running"), "FYI · sent", "running turn"],
    ["carried by a finished turn", fyi(true), run("completed"), "FYI", "a turn that finished"],
    ["given back by a stopped turn", fyi(true), run("interrupted"), "FYI · waiting", "next turn"],
  ] as const)("%s", (_name, item, carrier, label, description) => {
    const marker = resolveFyiMarker(item, carrier);
    expect(marker?.label).toBe(label);
    expect(marker?.description).toContain(description);
  });

  it("claims no state for a bound FYI whose run the client lacks", () => {
    expect(resolveFyiMarker(fyi(true), undefined)).toEqual({
      label: "FYI",
      description: "An agent's note for this thread.",
    });
  });

  it("keys only the runs FYI items name", () => {
    const other = { id: RunId.make("run:other"), status: "running" as const, rootNodeId: null };
    const carrier = { id: runId, ...run("running") };
    const named = fyiRunIds([fyi(true), fyi(false), undefined]);
    const { key, runs } = fyiCarrierRuns(named, [other, carrier]);
    expect([...runs.keys()]).toEqual([runId]);
    expect(fyiCarrierRuns(named, [{ ...other, status: "completed" }, carrier]).key).toBe(key);
    expect(fyiCarrierRuns(named, [{ ...carrier, status: "completed" }]).key).not.toBe(key);
  });
});
