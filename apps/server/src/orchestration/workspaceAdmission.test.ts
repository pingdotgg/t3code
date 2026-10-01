import {
  CommandId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { Effect } from "effect";
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
