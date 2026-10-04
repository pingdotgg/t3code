import {
  CommandId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThread,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  admitWorkspaceCommand,
  canonicalizeCommandWorktree,
  cleanupWorktreePath,
  commandWorktreePath,
  isWorktreeCleanupPending,
  type WorkspaceAdmissionDeps,
} from "./workspaceAdmission.ts";
import { WorkspaceOwnershipConflict } from "../persistence/Services/WorkspaceOwnership.ts";

const threadId = ThreadId.make("admission-thread");
const commandId = CommandId.make("admission-command");

function archiveCommand(): OrchestrationCommand {
  return { type: "thread.archive", commandId, threadId };
}

const depsWithoutOwnership: WorkspaceAdmissionDeps = {
  findThread: () => undefined,
  findProject: () => undefined,
  listThreads: () => [],
  claimOwnership: () => Effect.die(new Error("claim must not run without a path")),
  hasCleanupReservationByPath: () => Effect.succeed(false),
  createWorkspaceSnapshotCommit: () => Effect.die(new Error("snapshot must not run in this test")),
};

describe("commandWorktreePath", () => {
  it("reads the direct path from creation and handoff commands", () => {
    expect(
      commandWorktreePath({
        type: "thread.create",
        worktreePath: "/tmp/wt",
      } as OrchestrationCommand),
    ).toBe("/tmp/wt");
    expect(
      commandWorktreePath({
        type: "thread.workspace.handoff",
        worktreePath: "/tmp/wt",
      } as OrchestrationCommand),
    ).toBe("/tmp/wt");
  });

  it("returns null for commands without a direct path", () => {
    expect(commandWorktreePath(archiveCommand())).toBeNull();
    expect(
      commandWorktreePath({
        type: "thread.meta.update",
        worktreePath: null,
      } as OrchestrationCommand),
    ).toBeNull();
  });
});

describe("cleanupWorktreePath", () => {
  it("falls back to the thread worktree for queued and unarchive commands", () => {
    const threads = [{ id: threadId, worktreePath: "/tmp/thread-wt" } as OrchestrationThread];
    expect(
      cleanupWorktreePath(
        { type: "thread.queued-turn.dispatch", threadId } as OrchestrationCommand,
        threads,
      ),
    ).toBe("/tmp/thread-wt");
    expect(cleanupWorktreePath(archiveCommand(), [])).toBeNull();
  });
});

describe("canonicalizeCommandWorktree", () => {
  it("leaves commands without a worktree path untouched", async () => {
    const command = archiveCommand();
    await expect(Effect.runPromise(canonicalizeCommandWorktree(command))).resolves.toBe(command);
  });
});

describe("admitWorkspaceCommand", () => {
  it("returns pathless commands without claiming ownership", async () => {
    const claimOwnership = vi.fn(depsWithoutOwnership.claimOwnership);
    const command = await Effect.runPromise(
      admitWorkspaceCommand({ ...depsWithoutOwnership, claimOwnership }, archiveCommand()),
    );
    expect(command).toEqual(archiveCommand());
    expect(claimOwnership).not.toHaveBeenCalled();
  });

  it("maps an ownership conflict to an invariant error naming the owner", async () => {
    const claimOwnership = () =>
      Effect.fail(
        new WorkspaceOwnershipConflict({
          canonicalPath: "/tmp/wt",
          ownerThreadId: "owner-thread",
          requestedByThreadId: "admission-thread",
        }),
      );
    const command = {
      type: "thread.create",
      commandId,
      threadId,
      worktreePath: "/tmp",
    } as OrchestrationCommand;
    const failure = await Effect.runPromise(
      admitWorkspaceCommand({ ...depsWithoutOwnership, claimOwnership }, command).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((failure as Error).message).toContain("owner-thread");
  });

  it("attaches the claimed binding to the admitted command", async () => {
    const binding: WorkspaceBinding = {
      canonicalPath: "/tmp",
      worktreePath: "/tmp",
      branch: null,
      generation: 1,
    };
    const command = {
      type: "thread.create",
      commandId,
      threadId,
      worktreePath: "/tmp",
    } as OrchestrationCommand;
    const admitted = (await Effect.runPromise(
      admitWorkspaceCommand(
        { ...depsWithoutOwnership, claimOwnership: () => Effect.succeed(binding) },
        command,
      ),
    )) as { readonly workspaceBinding?: WorkspaceBinding };
    expect(admitted.workspaceBinding).toEqual(binding);
  });

  it("rejects handoff and meta.update targeting the project checkout", async () => {
    // The project checkout is reserved for the human: these commands must
    // fail before claiming ownership, never admit the main checkout as the
    // thread's workspace.
    const projectRoot = await mkdtemp(join(tmpdir(), "admission-project-"));
    execFileSync("git", ["init", projectRoot], { stdio: "ignore" });
    try {
      const projectId = "admission-project";
      const deps: WorkspaceAdmissionDeps = {
        findThread: () => ({ id: threadId, projectId }) as OrchestrationThread,
        findProject: () => ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
        listThreads: () => [],
        claimOwnership: () => Effect.die(new Error("must reject before claiming ownership")),
        hasCleanupReservationByPath: () => Effect.succeed(false),
        createWorkspaceSnapshotCommit: () =>
          Effect.die(new Error("snapshot must not run in this test")),
      };
      const commands = [
        {
          type: "thread.workspace.handoff",
          commandId,
          threadId,
          branch: "handoff-branch",
          worktreePath: projectRoot,
        },
        { type: "thread.meta.update", commandId, threadId, worktreePath: projectRoot },
      ] as Array<OrchestrationCommand>;
      for (const command of commands) {
        const failure = await Effect.runPromise(
          admitWorkspaceCommand(deps, command).pipe(Effect.flip),
        );
        expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
        expect((failure as Error).message).toContain("reserved for the human");
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("admitWorkspaceCommand fork lineage sharing", () => {
  const sourceThreadId = ThreadId.make("fork-family-source");
  const forkThreadId = ThreadId.make("fork-family-fork");
  const siblingThreadId = ThreadId.make("fork-family-sibling");
  const outsiderThreadId = ThreadId.make("fork-family-outsider");
  const worktreePath = "/tmp/fork-family-wt";

  const thread = (
    id: ThreadId,
    parentThreadId: ThreadId | null,
    overrides: Partial<OrchestrationThread> = {},
  ) =>
    ({
      id,
      projectId: "fork-family-project",
      title: id,
      modelSelection: { instanceId: "pi", model: "default" },
      interactionMode: "default",
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      branch: "t3/thread/fork-family",
      worktreePath,
      parentThreadId,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
      ...overrides,
    }) as unknown as OrchestrationThread;

  // The outsider shares the same worktree path but has no fork lineage: it is
  // the conflict case the family allowance must not loosen.
  const lineage = [
    thread(sourceThreadId, null),
    thread(forkThreadId, sourceThreadId),
    thread(siblingThreadId, sourceThreadId),
    thread(outsiderThreadId, null),
  ];
  const depsWith = (overrides: Partial<WorkspaceAdmissionDeps> = {}): WorkspaceAdmissionDeps => ({
    ...depsWithoutOwnership,
    findThread: (id) => lineage.find((entry) => entry.id === id),
    listThreads: () => lineage,
    claimOwnership: () =>
      Effect.succeed({
        canonicalPath: worktreePath,
        worktreePath,
        branch: "t3/thread/fork-family",
        generation: 2,
      }),
    ...overrides,
  });

  const turnStart = (id: ThreadId) =>
    ({
      type: "thread.turn.start",
      commandId,
      threadId: id,
    }) as unknown as OrchestrationCommand;

  it("offers a fork its source as a co-owner so the fork can claim the shared worktree", async () => {
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    await Effect.runPromise(
      admitWorkspaceCommand(depsWith({ claimOwnership }), turnStart(forkThreadId)),
    );
    expect(claimOwnership).toHaveBeenCalledTimes(1);
    const input = claimOwnership.mock.calls[0]![0];
    expect(input.coOwnerThreadIds).toContain(sourceThreadId);
    expect(input.coOwnerThreadIds).toContain(siblingThreadId);
    expect(input.coOwnerThreadIds).not.toContain(outsiderThreadId);
  });

  it("treats sibling forks of the same source as relatives", async () => {
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    await Effect.runPromise(
      admitWorkspaceCommand(depsWith({ claimOwnership }), turnStart(siblingThreadId)),
    );
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds).toContain(forkThreadId);
  });

  it("refuses while a relative is running so one checkout keeps a single writer", async () => {
    const running = lineage.map((entry) =>
      entry.id === sourceThreadId
        ? thread(sourceThreadId, null, {
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2025-01-01T00:00:00.000Z",
              startedAt: "2025-01-01T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    const failure = await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => running.find((entry) => entry.id === id),
          listThreads: () => running,
        }),
        turnStart(forkThreadId),
      ).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((failure as Error).message).toContain(sourceThreadId);
    expect(claimOwnership).not.toHaveBeenCalled();
  });

  it("leaves unrelated threads in conflict", async () => {
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    await Effect.runPromise(
      admitWorkspaceCommand(depsWith({ claimOwnership }), turnStart(outsiderThreadId)),
    );
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? []).not.toContain(sourceThreadId);
  });

  it("admits a delegated child that owns its own worktree while its parent runs", async () => {
    // `parentThreadId` is also the delegated-child relation (cli.ts sets it on
    // `thread.create` for `t3 chat new --parent`), and a child is allocated its
    // own isolated worktree while the parent's session is still running.
    const childThreadId = ThreadId.make("delegated-child");
    const childWorktree = "/tmp/fork-family-child-wt";
    const withChild = [
      ...lineage,
      thread(childThreadId, sourceThreadId, { worktreePath: childWorktree }),
    ];
    const runningSource = thread(sourceThreadId, null, {
      latestTurn: {
        turnId: TurnId.make("turn-running"),
        state: "running",
        requestedAt: "2025-01-01T00:00:00.000Z",
        startedAt: "2025-01-01T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const withRunningParent = withChild.map((entry) =>
      entry.id === sourceThreadId ? runningSource : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);

    await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => withRunningParent.find((entry) => entry.id === id),
          listThreads: () => withRunningParent,
        }),
        turnStart(childThreadId),
      ),
    );

    expect(claimOwnership).toHaveBeenCalledTimes(1);
    expect(claimOwnership.mock.calls[0]![0].worktreePath).toBe(childWorktree);
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? []).not.toContain(sourceThreadId);
  });

  it("ignores a relative bound to a different worktree", async () => {
    // A fork handed off to its own checkout no longer shares anything, so a
    // running source elsewhere must not block it.
    const handedOff = lineage.map((entry) =>
      entry.id === forkThreadId
        ? thread(forkThreadId, sourceThreadId, { worktreePath: "/tmp/fork-wt" })
        : entry,
    );
    const running = handedOff.map((entry) =>
      entry.id === sourceThreadId
        ? thread(sourceThreadId, null, {
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2025-01-01T00:00:00.000Z",
              startedAt: "2025-01-01T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);

    await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => running.find((entry) => entry.id === id),
          listThreads: () => running,
        }),
        turnStart(forkThreadId),
      ),
    );

    expect(claimOwnership).toHaveBeenCalledTimes(1);
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? []).toEqual([]);
  });

  it("ignores archived and deleted relatives left mid-turn", async () => {
    const stale = lineage.map((entry) =>
      entry.id === sourceThreadId
        ? thread(sourceThreadId, null, {
            archivedAt: "2025-01-02T00:00:00.000Z",
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2025-01-01T00:00:00.000Z",
              startedAt: "2025-01-01T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);

    await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => stale.find((entry) => entry.id === id),
          listThreads: () => stale,
        }),
        turnStart(forkThreadId),
      ),
    );

    // Claimed rather than refused: an archived relative stuck on a running turn
    // must not block its family with advice to stop an unstoppable thread. The
    // idle sibling on the same checkout is still a legitimate co-owner.
    expect(claimOwnership).toHaveBeenCalledTimes(1);
    const coOwners = claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? [];
    expect(coOwners).not.toContain(sourceThreadId);
    expect(coOwners).toContain(siblingThreadId);
  });
});

describe("isWorktreeCleanupPending", () => {
  it("delegates to the reservation lookup by canonical path", async () => {
    const hasCleanupReservationByPath = vi.fn(() => Effect.succeed(true));
    await expect(
      Effect.runPromise(isWorktreeCleanupPending({ hasCleanupReservationByPath }, "/tmp")),
    ).resolves.toBe(true);
    expect(hasCleanupReservationByPath).toHaveBeenCalledTimes(1);
  });
});
