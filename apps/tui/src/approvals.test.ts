import { describe, expect, it } from "bun:test";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { derivePendingApprovals } from "./approvals.ts";

/** Minimal activity fixture — only the fields derivePendingApprovals reads. */
const activity = (
  kind: string,
  payload: Record<string, unknown>,
  sequence: number,
): OrchestrationThreadActivity =>
  ({
    kind,
    payload,
    sequence,
    createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, sequence)).toISOString(),
  }) as unknown as OrchestrationThreadActivity;

describe("derivePendingApprovals", () => {
  it("Given an approval.requested with no matching resolved, then it stays open", () => {
    const open = derivePendingApprovals([
      activity("approval.requested", { requestId: "r1", requestKind: "command", detail: "ls" }, 1),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ requestId: "r1", requestKind: "command", detail: "ls" });
  });

  it("Given a request then a matching approval.resolved, then it is closed", () => {
    const open = derivePendingApprovals([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }, 1),
      activity("approval.resolved", { requestId: "r1" }, 2),
    ]);
    expect(open).toHaveLength(0);
  });

  it("Given a request then a respond.failed, then it is also closed", () => {
    const open = derivePendingApprovals([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }, 1),
      activity("provider.approval.respond.failed", { requestId: "r1" }, 2),
    ]);
    expect(open).toHaveLength(0);
  });

  it("Given two open requests, then both are returned in creation order", () => {
    const open = derivePendingApprovals([
      activity("approval.requested", { requestId: "r2", requestKind: "file-change" }, 2),
      activity("approval.requested", { requestId: "r1", requestKind: "command" }, 1),
    ]);
    expect(open.map((a) => a.requestId)).toEqual(["r1", "r2"]);
  });
});
