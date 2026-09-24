import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import {
  ThreadCliUsageError,
  deriveThreadCliTitle,
  findSettledTurn,
  listThreadCliThreads,
  resolveThreadCliMessageText,
  resolveThreadCliModelSelection,
  resolveThreadCliProject,
  resolveThreadCliTarget,
  resolveThreadCliWakeTime,
  selectTurnReply,
  threadCliStatus,
} from "./thread.ts";

const THREAD_ID = ThreadId.make("thread-1");
const snapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
  updatedAt: "2026-09-16T00:00:00.000Z",
};

it("resolves the current T3 thread from the agent environment", () => {
  const thread = resolveThreadCliTarget(snapshot, undefined, { T3_THREAD_ID: THREAD_ID });
  assert.strictEqual(thread.id, THREAD_ID);
});

it("prefers an explicit thread id over the agent environment", () => {
  const thread = resolveThreadCliTarget(snapshot, THREAD_ID, { T3_THREAD_ID: "other-thread" });
  assert.strictEqual(thread.id, THREAD_ID);
});

it("requires a target thread", () => {
  assert.throws(() => resolveThreadCliTarget(snapshot, undefined, {}), ThreadCliUsageError);
});

it("computes a future wake time from a duration", () => {
  const wake = resolveThreadCliWakeTime({
    duration: Duration.days(10),
    until: undefined,
    now: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
  });
  assert.strictEqual(wake, "2026-09-26T00:00:00.000Z");
});

it("requires exactly one wake-time option", () => {
  assert.throws(
    () =>
      resolveThreadCliWakeTime({
        duration: Duration.hours(1),
        until: "2026-09-17T00:00:00.000Z",
        now: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
      }),
    ThreadCliUsageError,
  );
});

const baseThread = snapshot.threads[0]!;
type TestThread = Omit<typeof baseThread, "latestTurn"> & {
  readonly latestTurn: ReturnType<typeof turn> | null;
};
const withThread = (overrides: Partial<TestThread>) => ({
  ...snapshot,
  threads: [{ ...baseThread, ...overrides }],
});
const turn = (turnId: string, state: "running" | "completed" | "interrupted" | "error") => ({
  turnId: TurnId.make(turnId),
  state,
  requestedAt: "2026-09-16T00:00:00.000Z",
  startedAt: "2026-09-16T00:00:01.000Z",
  completedAt: state === "running" ? null : "2026-09-16T00:00:05.000Z",
  assistantMessageId: null,
});
const message = (
  id: string,
  role: OrchestrationMessage["role"],
  turnId: string | null,
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
});

it("lists unarchived threads newest first and hides archived ones by default", () => {
  const older = {
    ...baseThread,
    id: ThreadId.make("older"),
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  const archived = {
    ...baseThread,
    id: ThreadId.make("archived"),
    updatedAt: "2026-09-17T00:00:00.000Z",
    archivedAt: "2026-09-17T00:00:00.000Z",
  };
  const multi = { ...snapshot, threads: [older, baseThread, archived] };
  assert.deepStrictEqual(
    listThreadCliThreads(multi, { includeArchived: false }).map((thread) => thread.id),
    [THREAD_ID, "older"],
  );
  assert.deepStrictEqual(
    listThreadCliThreads(multi, { includeArchived: true }).map((thread) => thread.id),
    ["archived", THREAD_ID, "older"],
  );
});

it("reports pending approvals ahead of a running turn", () => {
  const [thread] = withThread({
    latestTurn: turn("t1", "running"),
    hasPendingApprovals: true,
  }).threads;
  assert.strictEqual(threadCliStatus(thread!), "approval");
  assert.strictEqual(threadCliStatus(baseThread), "idle");
});

it("reads the message from stdin when the argument is omitted or '-'", () => {
  assert.strictEqual(
    resolveThreadCliMessageText("hi", () => "ignored"),
    "hi",
  );
  assert.strictEqual(
    resolveThreadCliMessageText(undefined, () => "  from stdin\n"),
    "from stdin",
  );
  assert.strictEqual(
    resolveThreadCliMessageText("-", () => "piped"),
    "piped",
  );
  assert.throws(() => resolveThreadCliMessageText(undefined, () => undefined), ThreadCliUsageError);
  assert.throws(() => resolveThreadCliMessageText("   ", () => "unused"), ThreadCliUsageError);
});

it("ignores the pre-dispatch turn until a new turn settles", () => {
  const stale = withThread({ latestTurn: turn("t1", "completed") });
  assert.strictEqual(findSettledTurn(stale, THREAD_ID, "t1"), undefined);

  const running = withThread({ latestTurn: turn("t2", "running") });
  assert.strictEqual(findSettledTurn(running, THREAD_ID, "t1"), undefined);

  const done = withThread({ latestTurn: turn("t2", "completed") });
  assert.deepStrictEqual(findSettledTurn(done, THREAD_ID, "t1"), {
    turnId: "t2",
    state: "completed",
  });

  const firstTurn = withThread({ latestTurn: turn("t1", "error") });
  assert.deepStrictEqual(findSettledTurn(firstTurn, THREAD_ID, null), {
    turnId: "t1",
    state: "error",
  });
});

it("joins every assistant message from the settled turn", () => {
  const messages = [
    message("m1", "user", "t2", "question"),
    message("m2", "assistant", "t1", "old answer"),
    message("m3", "assistant", "t2", "part one"),
    message("m4", "system", "t2", "noise"),
    message("m5", "assistant", "t2", "part two"),
  ];
  assert.strictEqual(selectTurnReply(messages, "t2"), "part one\n\npart two");
});

const project = (
  id: string,
  workspaceRoot: string,
  defaultModel: string | null = null,
): OrchestrationShellSnapshot["projects"][number] => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  defaultModelSelection:
    defaultModel === null
      ? null
      : { instanceId: ProviderInstanceId.make("codex"), model: defaultModel },
  scripts: [],
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
});

it("resolves the deepest project containing the working directory", () => {
  const projects = {
    ...snapshot,
    projects: [project("hub", "/u/hub"), project("app", "/u/hub/app")],
  };
  assert.strictEqual(resolveThreadCliProject(projects, undefined, "/u/hub/app/src").id, "app");
  assert.strictEqual(resolveThreadCliProject(projects, undefined, "/u/hub").id, "hub");
  assert.strictEqual(resolveThreadCliProject(projects, "/u/hub/", "/elsewhere").id, "hub");
  assert.throws(
    () => resolveThreadCliProject(projects, undefined, "/u/hubby"),
    ThreadCliUsageError,
  );
  assert.throws(() => resolveThreadCliProject(projects, "nope", "/u/hub"), ThreadCliUsageError);
});

it("picks the project default model, then the latest thread's, then explicit flags", () => {
  const none = { provider: undefined, model: undefined };
  const withDefault = project("project-1", "/p", "gpt-default");
  assert.strictEqual(
    resolveThreadCliModelSelection(snapshot, withDefault, none).model,
    "gpt-default",
  );

  const noDefault = project("project-1", "/p");
  assert.strictEqual(resolveThreadCliModelSelection(snapshot, noDefault, none).model, "gpt-5.6");

  const switched = resolveThreadCliModelSelection(snapshot, noDefault, {
    provider: "claudeAgent",
    model: "claude-opus-5",
  });
  assert.deepStrictEqual(switched, {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5",
  });
  assert.throws(
    () =>
      resolveThreadCliModelSelection(snapshot, noDefault, {
        provider: "claudeAgent",
        model: undefined,
      }),
    ThreadCliUsageError,
  );

  const empty = project("empty", "/e");
  assert.throws(() => resolveThreadCliModelSelection(snapshot, empty, none), ThreadCliUsageError);
});

it("titles a new thread from the first line of its message", () => {
  assert.strictEqual(deriveThreadCliTitle("Fix the build\nDetails follow"), "Fix the build");
  assert.strictEqual(deriveThreadCliTitle("x".repeat(80)).length, 60);
});
