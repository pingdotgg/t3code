import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  groupSummaryMember,
  groupSummaryMemberState,
  groupTurnSummary,
  type GroupSummaryMember,
} from "./GroupTurnSummary.ts";

const lead: GroupSummaryMember = {
  threadId: ThreadId.make("lead"),
  title: "Ship groups",
  state: "working",
  settled: false,
  snoozed: false,
};
const worker1: GroupSummaryMember = {
  threadId: ThreadId.make("worker-1"),
  title: "Server side",
  state: "working",
  settled: false,
  snoozed: false,
};
const worker2: GroupSummaryMember = {
  threadId: ThreadId.make("worker-2"),
  title: "Mobile side",
  state: "needs input",
  settled: true,
  snoozed: false,
};

it("renders the lead first and marks the caller", () => {
  expect(groupTurnSummary({ self: worker2.threadId, lead, workers: [worker1, worker2] }).text)
    .toBe(`T3 group "Ship groups" (you are a worker):
- Ship groups (lead): working
- Server side: working
- Mobile side (you): needs input, settled
Messages between group members are queued until the receiver's turn ends; read details with t3_thread_read.`);
  expect(
    groupTurnSummary({ self: lead.threadId, lead, workers: [worker1] })
      .text.split("\n")
      .slice(0, 2),
  ).toEqual([`T3 group "Ship groups" (you are the lead):`, "- Ship groups (lead, you): working"]);
});

it("keeps the fingerprint stable when only timestamps change", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const nowMs = DateTime.toEpochMillis(at("2026-11-18T12:00:00Z"));
  const shell = (stamp: string) => ({
    id: worker1.threadId,
    title: worker1.title,
    status: "completed" as const,
    pendingRuntimeRequest: null,
    settledOverride: null,
    snoozedUntil: at("2026-11-19T00:00:00Z"),
    snoozedAt: at(stamp),
    latestRunCompletedAt: at(stamp),
    pendingGuestMessageCount: 0,
  });
  const fingerprint = (stamp: string) =>
    groupTurnSummary({
      self: worker1.threadId,
      lead,
      workers: [groupSummaryMember(shell(stamp), nowMs)],
    }).fingerprint;

  expect(groupSummaryMember(shell("2026-11-18T10:00:00Z"), nowMs).snoozed).toBe(true);
  expect(fingerprint("2026-11-18T11:00:00Z")).toBe(fingerprint("2026-11-18T10:00:00Z"));
  expect(
    groupTurnSummary({
      self: worker1.threadId,
      lead,
      workers: [{ ...groupSummaryMember(shell("2026-11-18T10:00:00Z"), nowMs), state: "failed" }],
    }).fingerprint,
  ).not.toBe(fingerprint("2026-11-18T10:00:00Z"));
});

it.each([
  { status: "idle", pending: null, state: "idle" },
  { status: "preparing", pending: null, state: "working" },
  { status: "queued", pending: null, state: "working" },
  { status: "starting", pending: null, state: "working" },
  { status: "running", pending: null, state: "working" },
  { status: "waiting", pending: null, state: "done" },
  { status: "completed", pending: null, state: "done" },
  { status: "failed", pending: null, state: "failed" },
  { status: "interrupted", pending: null, state: "stopped" },
  { status: "cancelled", pending: null, state: "stopped" },
  { status: "rolled_back", pending: null, state: "stopped" },
  { status: "running", pending: "command", state: "needs input" },
  { status: "running", pending: "permission", state: "needs input" },
  { status: "waiting", pending: "user_input", state: "needs input" },
  { status: "running", pending: "dynamic_tool_call", state: "working" },
] as const)(
  "maps a $status run with a $pending request to $state",
  ({ status, pending, state }) => {
    expect(
      groupSummaryMemberState({
        status,
        pendingRuntimeRequest:
          pending === null
            ? null
            : {
                id: RuntimeRequestId.make("request"),
                kind: pending,
                createdAt: DateTime.makeUnsafe("2026-11-18T12:00:00Z"),
              },
      }),
    ).toBe(state);
  },
);
