import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { applyToProjection, emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import { codexSession, providerThread, runCreated, threadCreated } from "./ThreadMove.testkit.ts";
import { planThreadMove, type ThreadMoveMember } from "./ThreadMovePlan.ts";
import type { ThreadMoveReceiptInput } from "./ThreadMoveReceipt.ts";

const movedAt = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function projection(input: {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly branch?: string | null;
  readonly pullRequest?: { readonly number: number; readonly url: string } | null;
  readonly sessions?: ReadonlyArray<OrchestrationV2ProviderSession["status"]>;
  readonly claudeSession?: string;
  readonly runs?: ReadonlyArray<{ readonly id: string; readonly cwd?: string }>;
}): OrchestrationV2ThreadProjection {
  const threadId = ThreadId.make(input.id);
  return {
    ...emptyProjection(
      threadCreated({
        threadId,
        projectId: projectA,
        worktreePath: input.worktreePath,
        providerInstanceId: input.claudeSession === undefined ? codex : claude,
        branch: input.branch,
        branchPullRequest: input.pullRequest
          ? { projectId: projectA, repository: "o/r", ...input.pullRequest }
          : undefined,
      }),
    ),
    providerThreads:
      input.claudeSession === undefined
        ? []
        : [
            providerThread({
              id: `provider-thread:${input.id}`,
              threadId,
              providerInstanceId: claude,
              nativeId: input.claudeSession,
            }),
          ],
    providerSessions: (input.sessions ?? []).map((status) =>
      codexSession({
        id: `session:${input.id}:${status}`,
        status,
        cwd: input.worktreePath ?? "/work/a",
      }),
    ),
    runs: (input.runs ?? []).map(
      (run, index) =>
        runCreated({
          id: RunId.make(run.id),
          threadId,
          ordinal: index + 1,
          providerInstanceId: codex,
          cwd: run.cwd,
        }).payload,
    ),
  };
}

const receipt: ThreadMoveReceiptInput = {
  folder: "/work/b",
  previousFolder: "/work/a",
  project: "B",
  previousProject: "A",
  members: ["side"],
  clearedBranch: null,
  pullRequest: null,
  leftFolder: null,
};

const plan = Effect.fn("ThreadMovePlanTest.plan")(function* (input: {
  readonly members: ReadonlyArray<ThreadMoveMember>;
  readonly worktreePath?: string | null;
  readonly folder?: string;
  readonly folderChanged?: boolean;
}) {
  return yield* planThreadMove({
    command: {
      type: "thread.project.move",
      commandId: CommandId.make("command:move"),
      threadId: input.members[0]?.projection.thread.id ?? ThreadId.make("missing"),
      projectId: projectB,
      worktreePath: input.worktreePath ?? null,
    },
    members: input.members,
    folder: input.folder ?? "/work/b",
    folderChanged: input.folderChanged ?? true,
    receipt,
    now: movedAt,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
  });
});

type EventOf<T, Event = OrchestrationV2DomainEvent> = Event extends { readonly type: infer Type }
  ? T extends Type
    ? Event
    : never
  : never;
const ofType = <T extends OrchestrationV2DomainEvent["type"]>(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  type: T,
) => events.filter((event): event is EventOf<T> => event.type === type);
const noticeOf = (event: EventOf<"turn-item.updated">) =>
  event.payload.type === "system_notice" ? event.payload : assert.fail("Expected a system notice");

const member = (
  thread: OrchestrationV2ThreadProjection,
  previousFolder = "/work/a",
  nextOrdinal = 7,
  storageFolders: ReadonlyMap<ProviderThreadId, string> = new Map(),
): ThreadMoveMember => ({ projection: thread, previousFolder, storageFolders, nextOrdinal });

it.effect.each([
  { name: "root to root", worktreePath: null, from: "/work/a", to: "/work/b", scratch: null },
  { name: "worktree to root", worktreePath: "/wt", from: "/wt", to: "/work/b", scratch: null },
  { name: "/no", worktreePath: null, from: "/work/a", to: "/scratch/new", scratch: "/scratch/new" },
])("moves a thread and its member from $name in one batch", ({ worktreePath, from, to, scratch }) =>
  Effect.gen(function* () {
    const thread = projection({ id: "t", worktreePath, sessions: ["running", "stopped"] });
    const side = projection({ id: "side", worktreePath, sessions: ["ready"] });
    const { events, effects } = yield* plan({
      members: [member(thread, from, 7), member(side, from, 3)],
      worktreePath: scratch,
      folder: to,
    });
    expect(ofType(events, "thread.metadata-updated")).toMatchObject([
      { payload: { id: "t", projectId: projectB, worktreePath: scratch, branch: null } },
      { payload: { id: "side", projectId: projectB, worktreePath: scratch, branch: null } },
    ]);
    expect(ofType(events, "provider-session.detached")).toMatchObject([
      { threadId: "t", payload: { reason: "Workspace changed." } },
      { threadId: "side", payload: { reason: "Workspace changed." } },
    ]);
    const notices = ofType(events, "turn-item.updated").map(noticeOf);
    expect(notices).toMatchObject([
      { threadId: "t", ordinal: 7, runId: null, previousFolder: from },
      { threadId: "side", ordinal: 3, runId: null, previousFolder: from },
    ]);
    assert.isTrue(notices.every((item) => item.startedAt === movedAt));
    assert.include(notices[0]?.message ?? "", `The next turn runs in \`${receipt.folder}\`.`);
    assert.equal(
      notices[1]?.message,
      `Moved with t.\nThe next turn runs in \`${to}\`.\nThe receipt in t lists the details.`,
    );
    expect(effects).toMatchObject([
      { threadId: "t", request: { type: "provider-session.detach" } },
      { threadId: "t", request: { type: "scheduled-tasks.move" } },
      { threadId: "side", request: { type: "provider-session.detach" } },
      { threadId: "side", request: { type: "scheduled-tasks.move" } },
    ]);
    const after = events
      .filter((event) => event.threadId === ThreadId.make("t"))
      .reduce(applyToProjection, thread);
    assert.equal(after.thread.projectId, projectB);
    expect(after.providerSessions.map((session) => session.status)).toEqual(["stopped"]);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("a run that never recorded its folder keeps the one it ran in", () =>
  Effect.gen(function* () {
    const thread = projection({
      id: "t",
      worktreePath: null,
      runs: [{ id: "legacy" }, { id: "recorded", cwd: "/wt" }],
    });
    const { events } = yield* plan({ members: [member(thread)] });
    expect(ofType(events, "run.updated")).toMatchObject([
      { threadId: "t", payload: { id: "legacy", cwd: "/work/a" } },
    ]);
    const after = events.reduce(applyToProjection, thread);
    expect(after.runs.map((run) => run.cwd)).toEqual(["/work/a", "/wt"]);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("detaches nothing when the folder does not change", () =>
  Effect.gen(function* () {
    const thread = projection({
      id: "t",
      worktreePath: null,
      sessions: ["running"],
      runs: [{ id: "legacy" }],
    });
    const { events, effects } = yield* plan({ members: [member(thread)], folderChanged: false });
    expect(events).toMatchObject([
      { type: "thread.metadata-updated" },
      { type: "turn-item.updated" },
    ]);
    expect(effects.map(({ request }) => request.type)).toEqual(["scheduled-tasks.move"]);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("links the pull request a cleared branch tracked, once", () =>
  Effect.gen(function* () {
    const pullRequest = { number: 42, url: "https://github.com/o/r/pull/42" };
    const thread = projection({ id: "t", worktreePath: null, branch: "feature", pullRequest });
    const { events } = yield* plan({ members: [member(thread)] });
    const [synced] = ofType(events, "thread.pull-request-synced");
    expect(synced?.payload).toMatchObject({
      branch: null,
      branchPullRequest: null,
      pullRequests: [{ ...pullRequest, host: "github.com", repository: "o/r", source: "manual" }],
    });
    const after = events.reduce(applyToProjection, thread);
    assert.lengthOf(after.thread.pullRequests ?? [], 1);

    const withLinks = (pullRequests: typeof after.thread.pullRequests) => ({
      ...thread,
      thread: { ...thread.thread, pullRequests },
    });
    const again = yield* plan({ members: [member(withLinks(after.thread.pullRequests))] });
    assert.lengthOf(ofType(again.events, "thread.pull-request-synced"), 0);
    const dismissedAt = "2026-08-01T00:00:00.000Z";
    const dismissed = withLinks(
      after.thread.pullRequests?.map((link) => ({
        ...link,
        source: "stack-dismissed" as const,
        linkedAt: dismissedAt,
      })),
    );
    const relinked = yield* plan({ members: [member(dismissed)] });
    expect(ofType(relinked.events, "thread.pull-request-synced")).toMatchObject([
      { payload: { pullRequests: [{ number: 42, source: "manual", linkedAt: dismissedAt }] } },
    ]);
    const unbranched = projection({ id: "t", worktreePath: null, branch: null, pullRequest });
    const none = yield* plan({ members: [member(unbranched)] });
    assert.lengthOf(ofType(none.events, "thread.pull-request-synced"), 0);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("relocates each Claude member's native session after its detach", () =>
  Effect.gen(function* () {
    const thread = projection({
      id: "t",
      worktreePath: null,
      sessions: ["ready"],
      claudeSession: "sess-1",
    });
    const side = projection({ id: "side", worktreePath: null, claudeSession: "sess-2" });
    const codexOnly = projection({ id: "codex", worktreePath: null });
    const { effects } = yield* plan({
      members: [
        member(
          thread,
          "/work/a",
          7,
          new Map([[ProviderThreadId.make("provider-thread:t"), "/old"]]),
        ),
        member(side),
        member(codexOnly),
      ],
    });
    expect(effects).toMatchObject([
      { threadId: "t", request: { type: "provider-session.detach" } },
      { threadId: "t", request: { type: "provider-session.relocate-storage" } },
      { threadId: "t", request: { type: "scheduled-tasks.move" } },
      { threadId: "side", request: { type: "provider-session.relocate-storage" } },
      { threadId: "side", request: { type: "scheduled-tasks.move" } },
      { threadId: "codex", request: { type: "scheduled-tasks.move" } },
    ]);
    expect(
      effects.filter(({ request }) => request.type === "provider-session.relocate-storage"),
    ).toMatchObject([
      { request: { nativeSessionId: "sess-1", oldFolder: "/old", newFolder: "/work/b" } },
      { request: { nativeSessionId: "sess-2", oldFolder: "/work/a", newFolder: "/work/b" } },
    ]);
  }).pipe(Effect.provide(IdAllocator.layer)),
);
