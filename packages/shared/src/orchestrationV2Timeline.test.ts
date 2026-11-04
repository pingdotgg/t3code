import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
} from "./orchestrationV2Timeline.ts";

const runId = RunId.make("run:timeline-visibility");
const nodeId = NodeId.make("node:timeline-visibility");
const otherRunId = RunId.make("run:timeline-visibility:other");
const otherNodeId = NodeId.make("node:timeline-visibility:other");
type VisibilityInput = Parameters<typeof createOrchestrationV2TurnItemVisibility>[0];

const ordinaryStatuses = [
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
] as const;

describe.each([
  ["point", isOrchestrationV2TurnItemVisible],
  [
    "indexed",
    (input: Parameters<typeof isOrchestrationV2TurnItemVisible>[0]) =>
      createOrchestrationV2TurnItemVisibility(input)(input.item),
  ],
] as const)("%s timeline visibility", (_, isVisible) => {
  it("hides unpaired interruption results from superseded attempts", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it.each([
    { status: "running", visible: true },
    { status: "cancelled", visible: true },
    { status: "rolled_back", visible: false },
  ] as const)(
    "keeps paired superseded results unless the run is rolled back ($status)",
    ({ status, visible }) => {
      expect(
        isVisible({
          item: { type: "run_interrupt_result", runId, nodeId },
          runs: [{ id: runId, status }],
          attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
          items: [
            { type: "run_interrupt_request", runId, nodeId },
            { type: "run_interrupt_result", runId, nodeId },
          ],
        }),
      ).toBe(visible);
    },
  );

  it("keeps interruption results from terminal attempts without a request", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("hides queued user messages once their run is cancelled", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps non-queued user messages on cancelled runs", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "turn_start", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "turn_start", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("does not hide an interruption because another attempt was superseded", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [
          {
            runId,
            rootNodeId: NodeId.make("node:timeline-visibility:older"),
            status: "superseded",
          },
          { runId, rootNodeId: nodeId, status: "interrupted" },
        ],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it.each([
    ...ordinaryStatuses.map((status) => ({ status, hidden: [] })),
    { status: "cancelled", hidden: ["queued"] },
    {
      status: "rolled_back",
      hidden: ["queued", "start", "steer", "promoted", "legacy", "assistant", "request", "result"],
    },
  ] satisfies ReadonlyArray<{
    status: VisibilityInput["runs"][number]["status"];
    hidden: string[];
  }>)("keeps the correct transcript rows for $status runs", ({ status, hidden }) => {
    const rows = [
      { id: "queued", type: "user_message", inputIntent: "queued_turn", runId, nodeId },
      { id: "start", type: "user_message", inputIntent: "turn_start", runId, nodeId },
      { id: "steer", type: "user_message", inputIntent: "steer", runId, nodeId },
      {
        id: "promoted",
        type: "user_message",
        inputIntent: "promoted_queued_to_steer",
        runId,
        nodeId,
      },
      { id: "legacy", type: "user_message", runId, nodeId },
      { id: "assistant", type: "assistant_message", inputIntent: "queued_turn", runId, nodeId },
      { id: "request", type: "run_interrupt_request", runId, nodeId },
      { id: "result", type: "run_interrupt_result", runId, nodeId },
      { id: "null", type: "user_message", inputIntent: "queued_turn", runId: null, nodeId },
      {
        id: "missing",
        type: "user_message",
        inputIntent: "queued_turn",
        runId: otherRunId,
        nodeId,
      },
    ] satisfies ReadonlyArray<VisibilityInput["items"][number] & { id: string }>;
    const input = {
      runs: [{ id: runId, status }],
      attempts: [],
      items: rows,
    } satisfies VisibilityInput;
    expect(rows.filter((item) => isVisible({ ...input, item })).map((item) => item.id)).toEqual(
      [
        "queued",
        "start",
        "steer",
        "promoted",
        "legacy",
        "assistant",
        "request",
        "result",
        "null",
        "missing",
      ].filter((id) => !hidden.some((hiddenId) => hiddenId === id)),
    );
  });

  it.each([
    { name: "empty history", runs: [], attempts: [] },
    {
      name: "ordinary attempts",
      runs: [{ id: runId, status: "completed" }],
      attempts: [{ runId, rootNodeId: nodeId, status: "completed" }],
    },
  ] satisfies ReadonlyArray<Pick<VisibilityInput, "runs" | "attempts"> & { name: string }>)(
    "keeps all rows with $name",
    ({ runs, attempts }) => {
      const items = [
        { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        { type: "run_interrupt_result", runId, nodeId },
        { type: "assistant_message", runId: null, nodeId: null },
      ] satisfies VisibilityInput["items"];
      expect(items.filter((item) => isVisible({ item, runs, attempts, items }))).toEqual(items);
    },
  );

  it.each([
    { name: "unpaired", runId, nodeId, requests: [], visible: false },
    { name: "second root", runId, nodeId: otherNodeId, requests: [], visible: false },
    { name: "other run", runId: otherRunId, nodeId, requests: [], visible: true },
    {
      name: "unknown root",
      runId,
      nodeId: NodeId.make("node:unknown"),
      requests: [],
      visible: true,
    },
    { name: "null run", runId: null, nodeId, requests: [], visible: true },
    { name: "null node", runId, nodeId: null, requests: [], visible: true },
    { name: "other request", runId, nodeId, requests: [otherRunId], visible: false },
    { name: "null request", runId, nodeId, requests: [null], visible: false },
    { name: "paired request", runId, nodeId, requests: [runId], visible: true },
  ] satisfies ReadonlyArray<{
    name: string;
    runId: VisibilityInput["items"][number]["runId"];
    nodeId: VisibilityInput["items"][number]["nodeId"];
    requests: VisibilityInput["items"][number]["runId"][];
    visible: boolean;
  }>)("matches superseded roots and requests for $name results", (row) => {
    const item = { type: "run_interrupt_result", runId: row.runId, nodeId: row.nodeId } as const;
    const requests = row.requests.map((requestRunId) => ({
      type: "run_interrupt_request" as const,
      runId: requestRunId,
      nodeId: otherNodeId,
    }));
    for (const items of [
      [...requests, item],
      [item, ...requests],
    ]) {
      expect(
        isVisible({
          item,
          runs: [],
          attempts: [
            { runId, rootNodeId: nodeId, status: "superseded" },
            { runId, rootNodeId: otherNodeId, status: "superseded" },
          ],
          items,
        }),
      ).toBe(row.visible);
    }
  });
});

describe("indexed timeline visibility", () => {
  it.each([
    ...ordinaryStatuses.flatMap(
      (status) =>
        [
          { statuses: ["rolled_back", status], visible: true, ordinaryVisible: true },
          { statuses: ["cancelled", status], visible: true, ordinaryVisible: true },
          { statuses: [status, "rolled_back"], visible: false, ordinaryVisible: false },
          { statuses: [status, "cancelled"], visible: false, ordinaryVisible: true },
        ] as const,
    ),
    { statuses: ["rolled_back", "cancelled"], visible: false, ordinaryVisible: true },
    { statuses: ["cancelled", "rolled_back"], visible: false, ordinaryVisible: false },
    {
      statuses: ["rolled_back", "running", "cancelled", "completed"],
      visible: true,
      ordinaryVisible: true,
    },
  ] satisfies ReadonlyArray<{
    statuses: ReadonlyArray<VisibilityInput["runs"][number]["status"]>;
    visible: boolean;
    ordinaryVisible: boolean;
  }>)(
    "uses the last duplicate run status in $statuses",
    ({ statuses, visible, ordinaryVisible }) => {
      const queued = { type: "user_message", inputIntent: "queued_turn", runId, nodeId } as const;
      const ordinary = { type: "assistant_message", runId, nodeId } as const;
      const isVisible = createOrchestrationV2TurnItemVisibility({
        runs: statuses.map((status) => ({ id: runId, status })),
        attempts: [],
        items: [queued, ordinary],
      });
      expect(isVisible(queued)).toBe(visible);
      expect(isVisible(ordinary)).toBe(ordinaryVisible);
    },
  );

  it("preserves frozen rows and reads fresh status and attempt snapshots", () => {
    const item = Object.freeze({ type: "run_interrupt_result", runId, nodeId } as const);
    const queued = Object.freeze({
      type: "user_message",
      inputIntent: "queued_turn",
      runId,
      nodeId,
    } as const);
    const items = Object.freeze([item, queued]);
    const attempts = Object.freeze([
      Object.freeze({ runId, rootNodeId: nodeId, status: "superseded" } as const),
    ]);
    const runs = Object.freeze([Object.freeze({ id: runId, status: "running" } as const)]);
    const input = Object.freeze({ runs, attempts, items });
    const before = structuredClone(input);
    const visible = items.filter(createOrchestrationV2TurnItemVisibility(input));
    expect(visible).toEqual([queued]);
    expect(visible[0]).toBe(queued);
    expect(input).toEqual(before);
    expect(
      items.filter(createOrchestrationV2TurnItemVisibility({ ...input, attempts: [] })),
    ).toEqual(items);
    expect(
      items.filter(
        createOrchestrationV2TurnItemVisibility({
          ...input,
          runs: [{ id: runId, status: "cancelled" }],
        }),
      ),
    ).toEqual([]);
    expect(
      items.filter(
        createOrchestrationV2TurnItemVisibility({
          ...input,
          items: [...items, { type: "run_interrupt_request", runId, nodeId: null }],
        }),
      ),
    ).toEqual(items);
  });
});
