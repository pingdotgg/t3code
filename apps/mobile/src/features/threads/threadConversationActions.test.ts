import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadActionCanReturnHome, threadConversationActions } from "./threadConversationActions";
const environmentId = EnvironmentId.make("remote");
function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const now = "2026-09-20T05:00:00Z";
const base = makeThread({ id: ThreadId.make("thread"), title: "Thread" });
const caps = {
  threadSettlement: true,
  threadSnooze: true,
  threadPinning: true,
  threadTitleRegeneration: true,
};
const ids = (thread = base, capabilities = caps, queued = false) =>
  threadConversationActions(thread, capabilities, now, queued).map((item) => item.id);
it("old servers retain rename/archive/delete without unsupported commands", () => {
  expect(
    ids(base, {
      threadSettlement: false,
      threadSnooze: false,
      threadPinning: false,
      threadTitleRegeneration: false,
    }),
  ).toEqual(["rename", "archive", "delete"]);
});
it("offers inverse organization actions for an organized thread", () => {
  expect(
    ids({
      ...base,
      pinnedAt: now,
      settledOverride: "settled",
      snoozedAt: now,
      snoozedUntil: "2026-09-20T06:00:00Z",
    }),
  ).toEqual(["rename", "regenerate", "unpin", "unsettle", "unsnooze", "archive", "delete"]);
});
it("archived conversations offer restoration and deletion only", () => {
  expect(ids({ ...base, archivedAt: now })).toEqual(["unarchive", "delete"]);
});
it("queued work and requests cannot be snoozed", () => {
  expect(ids(base, caps, true)).not.toContain("snooze");
  expect(ids({ ...base, hasPendingApprovals: true })).not.toContain("snooze");
  expect(ids({ ...base, hasPendingUserInput: true })).not.toContain("snooze");
});
it("a passed wake time restores snooze instead of wake", () => {
  const result = ids({
    ...base,
    snoozedAt: "2026-09-19T05:00:00Z",
    snoozedUntil: "2026-09-20T04:00:00Z",
  });
  expect(result).toContain("snooze");
  expect(result).not.toContain("unsnooze");
});
it("queued work overrides settled presentation like the list", () => {
  expect(ids({ ...base, settledOverride: "settled" }, caps, true)).toContain("settle");
  expect(ids({ ...base, settledOverride: "settled" }, caps, true)).not.toContain("unsettle");
});

it("a delayed completion returns only from the same environment-qualified route", () => {
  expect(threadActionCanReturnHome({ environmentId: "remote", threadId: "thread" }, base)).toBe(
    true,
  );
  expect(threadActionCanReturnHome({ environmentId: "other", threadId: "thread" }, base)).toBe(
    false,
  );
  expect(threadActionCanReturnHome({ environmentId: "remote", threadId: "other" }, base)).toBe(
    false,
  );
  expect(threadActionCanReturnHome(undefined, base)).toBe(false);
});
