import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  switchRef: (async () => undefined) as (input: unknown) => Promise<unknown>,
}));

const threads: Record<string, { branch: string; worktreePath: string }> = {
  "thread-a": { branch: "feature-a", worktreePath: "/repo/.worktrees/a" },
  "thread-b": { branch: "feature-b", worktreePath: "/repo/.worktrees/b" },
};

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: { projectId: string } | null) =>
    ref === null ? null : { id: ref.projectId, workspaceRoot: "/repo" }) as never,
  useQuietThreadShell: ((ref: { environmentId: string; threadId: string }) => ({
    ...threads[ref.threadId],
    id: ref.threadId,
    environmentId: ref.environmentId,
    projectId: "project",
    runtime: null,
  })) as never,
  useThreadShellsForProjectRefs: (() => []) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: null, error: null, refresh: () => undefined })) as never,
}));
vi.mock(import("~/state/queries"), async (original) => ({
  ...(await original()),
  usePaginatedBranches: (() => ({
    refs: [{ name: "other", current: false, isDefault: false, isRemote: false }],
    data: { nextCursor: null, totalCount: 1 },
    isPending: false,
    isFetchingNextPage: false,
    refresh: () => undefined,
    loadNext: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { vcsEnvironment } = await import("~/state/vcs");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === vcsEnvironment.switchRef
        ? (input: unknown) => state.switchRef(input)
        : async () => AsyncResult.success(undefined)) as never,
  };
});

import { render } from "../../test/render";
import { BranchToolbar } from "./BranchToolbar";

const environmentId = EnvironmentId.make("environment");

function setup() {
  state.switchRef = async () => undefined;
}

function toolbar(threadId: string, layout: "composer" | "panel") {
  return (
    <BranchToolbar
      layout={layout}
      panelSection="branch"
      environmentId={environmentId}
      threadId={ThreadId.make(threadId)}
      projectId={ProjectId.make("project")}
      worktreePath={threads[threadId]!.worktreePath}
      isServerThread
      showGitControls
      envMode="worktree"
      onEnvModeChange={() => undefined}
      startFromOrigin={false}
      onStartFromOriginChange={() => undefined}
      envLocked={false}
    />
  );
}

it.each(["composer", "panel"] as const)(
  "keeps a pending ref switch in one thread out of the next thread's %s picker",
  async (layout) => {
    setup();
    let finishThreadA: (result: unknown) => void = () => undefined;
    state.switchRef = () =>
      new Promise((resolve) => {
        finishThreadA = resolve;
      });
    await using screen = await render(toolbar("thread-a", layout));
    const picker = screen.getByRole("combobox");

    await picker.click();
    await page.getByRole("option", { name: "other" }).click();
    await expect.element(picker).toHaveTextContent("other");
    await expect.element(picker).toBeDisabled();

    // ChatView stays mounted across server threads, so the toolbar sees thread B in place.
    await screen.rerender(toolbar("thread-b", layout));
    await expect.element(picker).toHaveTextContent("feature-b");
    await expect.element(picker).toBeEnabled();

    finishThreadA(AsyncResult.success({ refName: "other" }));
    await expect.element(picker).toHaveTextContent("feature-b");
    await expect.element(picker).toBeEnabled();
  },
);
