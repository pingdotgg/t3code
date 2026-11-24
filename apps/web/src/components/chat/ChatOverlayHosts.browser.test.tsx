import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type TaskFolder,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import type { EnvironmentQueryView } from "~/state/query";
import { render } from "../../../test/render";

let mockTaskFolder: {
  readonly data: { readonly taskFolder: TaskFolder | null } | null;
  readonly isPending: boolean;
} = { data: null, isPending: false };

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (<A, E>(atom: unknown): EnvironmentQueryView<A, E> => ({
    data: (atom === null ? null : mockTaskFolder.data) as A | null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: atom !== null && mockTaskFolder.isPending,
    isSuccess: atom !== null && !mockTaskFolder.isPending && mockTaskFolder.data !== null,
    refresh: () => {},
  })) as (typeof import("../../state/query"))["useEnvironmentQuery"],
}));

import { openRevertConfirm, RevertConfirmHost } from "./ChatOverlayHosts";
import { retainThreadOverlaysForThread } from "./threadOverlayRetention";

const now = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const threadKey = "env-1:thread-1";
const messageId = MessageId.make("message-1");
const rootScopeId = CheckpointScopeId.make("scope-root");

function makeScope(
  id: string,
  cwd: string,
  repositoryPath?: string,
): OrchestrationV2CheckpointScope {
  return {
    id: CheckpointScopeId.make(id),
    threadId,
    runId: null,
    nodeId: NodeId.make("node-1"),
    parentScopeId: repositoryPath === undefined ? null : rootScopeId,
    providerThreadId: null,
    kind: repositoryPath === undefined ? "root_run" : "manual",
    ordinalWithinParent: 0,
    advancesAppRunCount: repositoryPath === undefined,
    cwd,
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
    createdAt: now,
  };
}

function makeCheckpoint(
  id: string,
  scopeId: string,
  ordinal: number,
  overrides: Partial<OrchestrationV2Checkpoint> = {},
): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(id),
    threadId,
    scopeId: CheckpointScopeId.make(scopeId),
    runId: ordinal === 0 ? null : RunId.make(`run-${ordinal}`),
    nodeId: NodeId.make("node-1"),
    parentCheckpointId: null,
    ordinalWithinScope: ordinal,
    appRunOrdinal: ordinal === 0 ? null : ordinal,
    ref: CheckpointRef.make(`refs/t3/${id}`),
    status: "ready",
    files: [],
    capturedAt: now,
    ...overrides,
  };
}

function setup(
  taskFolder: {
    readonly data: { readonly taskFolder: TaskFolder | null } | null;
    readonly isPending: boolean;
  } = { data: null, isPending: false },
) {
  mockTaskFolder = taskFolder;
  retainThreadOverlaysForThread(null);
  return {
    [Symbol.dispose]: () => retainThreadOverlaysForThread(null),
  };
}

describe("RevertConfirmHost", () => {
  it.each([
    {
      name: "hides file restore in a side chat without a worktree",
      isSideChat: true,
      worktreePath: null,
      status: "missing" as const,
      expectedReason: "side chats do not snapshot files",
    },
    {
      name: "hides file restore in a side chat even when it inherits a worktree",
      isSideChat: true,
      worktreePath: "/work/tree",
      status: "missing" as const,
      expectedReason: "side chats do not snapshot files",
    },
    {
      name: "hides file restore when the thread runs in the project folder",
      isSideChat: false,
      worktreePath: null,
      status: "ready" as const,
      expectedReason: "file restore requires a worktree",
    },
    {
      name: "hides file restore when a worktree checkpoint has no file snapshot",
      isSideChat: false,
      worktreePath: "/work/tree",
      status: "missing" as const,
      expectedReason: "no file snapshot is available for this message",
    },
  ])("$name", async ({ isSideChat, worktreePath, status, expectedReason }) => {
    using _cleanup = setup();
    const onConfirm = vi.fn();
    openRevertConfirm(threadKey, { turnCount: 1, messageId });
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RevertConfirmHost
          threadKey={threadKey}
          environmentId={environmentId}
          taskFolderPath={worktreePath}
          worktreePath={worktreePath}
          isSideChat={isSideChat}
          projection={{
            checkpointScopes: [makeScope("scope-root", "/work/tree")],
            checkpoints: [makeCheckpoint("cp-1", "scope-root", 1, { status })],
          }}
          onConfirm={onConfirm}
        />
      </RegistryContext.Provider>,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(page.getByRole("button", { name: "Revert files too" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Revert repositories too" }).query()).toBeNull();
    await expect.element(page.getByText(expectedReason, { exact: false })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Revert and keep changes" }));
    expect(onConfirm).toHaveBeenCalledWith(1, messageId, false);
  });

  it("offers Revert files too when a worktree thread has a ready snapshot", async () => {
    using _cleanup = setup();
    const onConfirm = vi.fn();
    openRevertConfirm(threadKey, { turnCount: 1, messageId });
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RevertConfirmHost
          threadKey={threadKey}
          environmentId={environmentId}
          taskFolderPath="/work/tree"
          worktreePath="/work/tree"
          isSideChat={false}
          projection={{
            checkpointScopes: [makeScope("scope-root", "/work/tree")],
            checkpoints: [makeCheckpoint("cp-1", "scope-root", 1, { status: "ready" })],
          }}
          onConfirm={onConfirm}
        />
      </RegistryContext.Provider>,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    const revertFilesButton = page.getByRole("button", { name: "Revert files too" });
    await expect.element(revertFilesButton).toBeVisible();
    await expect.element(revertFilesButton).toBeEnabled();
    await userEvent.click(revertFilesButton);
    expect(onConfirm).toHaveBeenCalledWith(1, messageId, true);
  });

  it("offers Revert repositories too for a linked task folder with repository snapshots", async () => {
    using _cleanup = setup({
      data: {
        taskFolder: {
          root: "/work/task",
          projectId: ProjectId.make("project-1"),
          projectRoot: "/work/project",
          anchor: "/work/task",
          projectPath: "/work/project",
          projectIsWorktree: false,
          repositories: [],
        },
      },
      isPending: false,
    });
    const onConfirm = vi.fn();
    openRevertConfirm(threadKey, { turnCount: 1, messageId });
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RevertConfirmHost
          threadKey={threadKey}
          environmentId={environmentId}
          taskFolderPath="/work/task"
          worktreePath="/work/task"
          isSideChat={false}
          projection={{
            checkpointScopes: [
              makeScope("scope-root", "/work/task"),
              makeScope("scope-repo", "/work/task/app", "/work/project/app"),
            ],
            checkpoints: [
              makeCheckpoint("cp-root-1", "scope-root", 1, { status: "missing" }),
              makeCheckpoint("cp-repo-1", "scope-repo", 1, { status: "ready" }),
            ],
          }}
          onConfirm={onConfirm}
        />
      </RegistryContext.Provider>,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    const revertReposButton = page.getByRole("button", { name: "Revert repositories too" });
    await expect.element(revertReposButton).toBeVisible();
    await expect.element(revertReposButton).toBeEnabled();
    await userEvent.click(revertReposButton);
    expect(onConfirm).toHaveBeenCalledWith(1, messageId, true);
  });
});
