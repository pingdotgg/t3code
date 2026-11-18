import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  groupLeadArchiveDetail,
  groupLeadDeleteDetail,
  planGroupSettle,
  planGroupSnooze,
  resolveAttachTargets,
} from "./threadGroupActions";

const environmentId = EnvironmentId.make("primary");

function makeThread(id: string, input: Partial<EnvironmentThreadShell> = {}) {
  return makeThreadShellFixture({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project"),
    ...input,
  });
}

const ids = (threads: ReadonlyArray<EnvironmentThreadShell>) => threads.map((thread) => thread.id);

describe("planGroupSettle", () => {
  const lead = makeThread("lead");
  const idle = makeThread("idle");
  const busy = makeThread("busy");
  const done = makeThread("done", { settledOverride: "settled" });
  const isInFlight = (thread: EnvironmentThreadShell) => thread.id === "busy";

  it("settles the whole group, skips settled workers, and counts working members", () => {
    const plan = planGroupSettle(lead, [idle, busy, done], { finishedOnly: false, isInFlight });
    expect(ids(plan.targets)).toEqual(["lead", "idle", "busy"]);
    expect(plan.working).toBe(1);
  });

  it("settles only finished members when asked, and keeps an in-flight lead", () => {
    const finished = planGroupSettle(lead, [idle, busy, done], { finishedOnly: true, isInFlight });
    expect(ids(finished.targets)).toEqual(["lead", "idle"]);

    const busyLead = planGroupSettle(busy, [idle], { finishedOnly: true, isInFlight });
    expect(ids(busyLead.targets)).toEqual(["idle"]);
    expect(busyLead.working).toBe(1);
  });
});

describe("planGroupSnooze", () => {
  const now = "2026-06-01T00:00:00.000Z";

  it("snooze group skips a member that cannot snooze", () => {
    const lead = makeThread("lead");
    const plain = makeThread("plain");
    const waiting = makeThread("waiting", { hasPendingApprovals: true });
    const settled = makeThread("settled", { settledOverride: "settled" });
    const asleep = makeThread("asleep", { snoozedUntil: "2026-07-01T00:00:00.000Z" });

    const plan = planGroupSnooze(lead, [plain, waiting, settled, asleep], { now });
    expect(ids(plan.targets)).toEqual(["lead", "plain"]);
    expect(ids(plan.skipped)).toEqual(["waiting"]);
  });
});

describe("resolveAttachTargets", () => {
  it("lists same-environment listed threads, same project first, newest first", () => {
    const thread = makeThread("me");
    const older = makeThread("older", { updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeThread("newer", { updatedAt: "2026-02-01T00:00:00.000Z" });
    const elsewhere = makeThread("elsewhere", {
      projectId: ProjectId.make("other-project"),
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const worker = makeThread("worker", { groupParentThreadId: thread.id });
    const archived = makeThread("archived", { archivedAt: "2026-01-01T00:00:00.000Z" });
    const otherEnvironment = makeThread("remote", { environmentId: EnvironmentId.make("other") });
    const subagent = makeThread("subagent", {
      lineage: {
        rootThreadId: ThreadId.make("subagent"),
        parentThreadId: thread.id,
        relationshipToParent: "subagent",
      },
    });

    const targets = resolveAttachTargets(
      [older, thread, elsewhere, worker, archived, otherEnvironment, subagent, newer],
      thread,
    );
    expect(ids(targets)).toEqual(["newer", "older", "elsewhere"]);
  });
});

describe("group lead copy", () => {
  it("words the archive and delete details for one and several workers", () => {
    expect(groupLeadArchiveDetail(1)).toBe(
      "1 thread of this group will be shown separately while it is archived.",
    );
    expect(groupLeadArchiveDetail(3)).toBe(
      "3 threads of this group will be shown separately while it is archived.",
    );
    expect(groupLeadDeleteDetail(1)).toBe(
      "1 thread of this group will stay and become an ordinary thread.",
    );
    expect(groupLeadDeleteDetail(3)).toBe(
      "3 threads of this group will stay and become ordinary threads.",
    );
  });
});
