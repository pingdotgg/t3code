import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingNewTasks,
  type PendingDraftProjectDefaults,
  pendingDraftBranchNeedsRefs,
  resolvePendingDraftBranch,
} from "./pending-new-tasks-model";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { ComposerDraft, ComposerDraftWorkspaceSelection } from "./use-composer-drafts";

const projectCwd = "/repo";
const localDefault: PendingDraftProjectDefaults = {
  canChooseWorkspace: true,
  defaultMode: "local",
  defaultModeSettled: true,
};
const worktreeDefault: PendingDraftProjectDefaults = { ...localDefault, defaultMode: "worktree" };
const resolve = (
  input: Omit<Parameters<typeof resolvePendingDraftBranch>[0], "defaults" | "isGitRepo"> & {
    readonly defaults?: PendingDraftProjectDefaults;
  },
) => resolvePendingDraftBranch({ defaults: localDefault, isGitRepo: true, ...input });
const branches = [
  { name: "feature", current: true, isDefault: false },
  { name: "origin/main", current: false, isDefault: true, isRemote: true },
];

function draft(workspaceSelection?: ComposerDraftWorkspaceSelection): ComposerDraft {
  return {
    text: "unsent",
    attachments: [],
    project: {
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
      createdAt: "2026-10-26T00:00:00.000Z",
    },
    ...(workspaceSelection ? { workspaceSelection } : {}),
  };
}

describe("resolvePendingDraftBranch", () => {
  it("shows the project's default for a draft that never picked a mode", () => {
    const untouched = draft();
    expect(pendingDraftBranchNeedsRefs(untouched, worktreeDefault)).toBe(true);
    expect(resolve({ draft: untouched, defaults: worktreeDefault, branches, projectCwd })).toBe(
      "origin/main",
    );
    // Until t3.json settles, the environment default may still be replaced.
    expect(
      resolve({
        draft: untouched,
        defaults: { ...worktreeDefault, defaultModeSettled: false },
        branches,
        projectCwd,
      }),
    ).toBeNull();
    // A local default starts on the checkout without naming a branch, as on main.
    expect(pendingDraftBranchNeedsRefs(untouched, localDefault)).toBe(false);
    expect(resolve({ draft: untouched, branches, projectCwd })).toBeNull();
  });

  it("shows the default base for a worktree draft that never picked one", () => {
    const worktree = draft({ mode: "worktree", branch: null, worktreePath: null });
    expect(pendingDraftBranchNeedsRefs(worktree, localDefault)).toBe(true);
    expect(resolve({ draft: worktree, branches, projectCwd })).toBe("origin/main");
  });

  it("shows the current branch for a local draft that follows the checkout", () => {
    const local = draft({
      mode: "local",
      branch: null,
      worktreePath: null,
      followsCurrentCheckout: true,
    });
    expect(resolve({ draft: local, branches, projectCwd })).toBe("feature");
    expect(resolve({ draft: local, branches: [], projectCwd })).toBeNull();
  });

  it("keeps a chosen branch without loading refs", () => {
    const chosen = draft({ mode: "local", branch: "release", worktreePath: null });
    expect(pendingDraftBranchNeedsRefs(chosen, localDefault)).toBe(false);
    expect(resolve({ draft: chosen, branches, projectCwd })).toBe("release");
  });
});

function queuedCreation(environmentId: string): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(`thread-${environmentId}`),
    messageId: MessageId.make(`message-${environmentId}`),
    commandId: CommandId.make(`command-${environmentId}`),
    text: "Test",
    attachments: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    creation: {
      projectId: ProjectId.make("project-1"),
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    },
    createdAt: "2026-11-10T01:10:00.000Z",
  };
}

describe("buildPendingNewTasks", () => {
  it("lists only creations the outbox is not sending yet", () => {
    const sending = EnvironmentId.make("sending");
    const syncing = EnvironmentId.make("syncing");
    const readOnly = EnvironmentId.make("read-only");
    const retrying = EnvironmentId.make("retrying");
    const { modelSelection: _model, ...modelless } = queuedCreation("sending");
    const tasks = buildPendingNewTasks({
      queuedMessages: [
        ...["sending", "syncing", "read-only", "retrying", "offline"].map(queuedCreation),
        { ...modelless, messageId: MessageId.make("message-modelless") },
      ],
      drafts: {},
      sendGate: {
        connectedEnvironmentIds: new Set([sending, syncing, readOnly, retrying]),
        operableEnvironmentIds: new Set([sending, syncing, retrying]),
        shellStatuses: new Map([
          [sending, "live"],
          [syncing, "synchronizing"],
          [readOnly, "live"],
          [retrying, "live"],
        ]),
        retryingMessageIds: { [MessageId.make("message-retrying")]: true },
      },
    });

    expect(tasks).toHaveLength(5);
    expect(new Set(tasks.map((task) => task.environmentId))).toEqual(
      new Set(["syncing", "read-only", "retrying", "offline", "sending"]),
    );
  });
});
