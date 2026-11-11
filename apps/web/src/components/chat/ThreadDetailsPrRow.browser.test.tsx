import { EnvironmentId, ProjectId, ThreadId, type PullRequestCheck } from "@t3tools/contracts";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  url: "https://github.com/owner/repo/pull/1",
  conflicting: false,
  extraStatus: null as PullRequestCheck["status"] | null,
  mergeMethods: ["merge"] as Array<"merge" | "squash" | "rebase">,
  perform: vi.fn(),
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  checkoutError: null as Error | null,
  addToast: vi.fn(),
  updateToast: vi.fn(),
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  // Rows render a pull request only with a project, so this does not reach tests that pass none.
  useServerConfigs: (() =>
    new Map([
      [
        EnvironmentId.make("environment"),
        { environment: { capabilities: { pullRequests: true } } },
      ],
    ])) as never,
}));
const queryData = () => ({
  projectId: ProjectId.make("project"),
  workspaceRoot: "/workspace",
  url: state.url,
  number: 1,
  title: "Test PR",
  state: "open" as const,
  isDraft: false,
  mergeability: state.conflicting ? "conflicting" : "mergeable",
  headBranch: "feature",
  baseBranch: "main",
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  checks: [state.status, ...(state.extraStatus ? [state.extraStatus] : [])].map((status) => ({
    name: `CI-${status}`,
    status,
    description: null,
    url: null,
  })),
  capabilities: { actions: ["merge"], mergeMethods: state.mergeMethods },
  viewerPermissions: { actions: ["merge"] },
  mergeCapabilities: {
    merge: state.mergeMethods.includes("merge"),
    squash: state.mergeMethods.includes("squash"),
    rebase: state.mergeMethods.includes("rebase"),
  },
});
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuerySelector: ((_atom: unknown, select: (result: unknown) => unknown) =>
    select(AsyncResult.success(queryData()))) as never,
  useEnvironmentQueryIsNewer: () => true,
  useEnvironmentQueryRefresh: () => ({ refresh: vi.fn(), isPending: () => false }),
  useEnvironmentQuery: (() => ({
    data: {
      code: { additions: 1, deletions: 0 },
      tests: { additions: 0, deletions: 0 },
      mocks: { additions: 0, deletions: 0 },
      generated: { additions: 0, deletions: 0 },
      docs: { additions: 7, deletions: 3 },
    },
    isPending: false,
  })) as never,
}));
vi.mock(import("../pullRequest/usePullRequestActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
}));

vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => state.newThread) as never,
}));
vi.mock(import("~/state/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    run: state.prepareThread,
    isAllowed: true,
    error: state.checkoutError,
  })) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.addToast,
      update: state.updateToast,
    } as never,
  };
});

import { act, render as renderUi } from "../../../test/render";
import { useUiStateStore } from "~/uiStateStore";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import {
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
} from "../pullRequest/pullRequestDetail.logic";

it("merges with the last selected merge method", async () => {
  await using screen = await setup();
  const { container } = screen;
  state.mergeMethods = ["merge", "squash"];
  useUiStateStore.getState().setPullRequestMergeMethod("squash");
  await act(async () => {
    await screen.rerender(
      <ThreadDetailsPrRow
        environmentId={EnvironmentId.make("environment")}
        pr={null}
        number={1}
        status={null}
        project={null}
        label="Test PR"
        openAriaLabel="Open PR"
        onOpen={vi.fn()}
      />,
    );
  });
  const clickMerge = async (scope: ParentNode) =>
    await act(async () => {
      [...scope.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Merge")!
        .click();
    });
  await clickMerge(container);
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("using squash");
  await clickMerge(dialog);
  expect(state.perform).toHaveBeenCalledWith("merge", "squash");
});

it("requires a new merge click after passing checks become pending and pass again", async () => {
  await using screen = await setup();
  const { container } = screen;
  const render = () => (
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("environment")}
      pr={null}
      number={1}
      status={null}
      project={null}
      label="Test PR"
      openAriaLabel="Open PR"
      onOpen={vi.fn()}
    />
  );
  const clickMerge = async () =>
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Merge")!
        .click();
    });
  const dialogs = () => [...document.querySelectorAll('[role="alertdialog"]')];

  await act(async () => await screen.rerender(render()));
  await clickMerge();
  expect(dialogs()).toHaveLength(1);
  await act(async () => {
    state.status = "pending";
    await screen.rerender(render());
  });
  expect(dialogs()).toHaveLength(0);
  await act(async () => {
    state.status = "success";
    await screen.rerender(render());
  });
  expect(dialogs()).toHaveLength(0);
  await clickMerge();
  expect(dialogs()).toHaveLength(1);
  expect(state.perform).not.toHaveBeenCalled();
});

it.each([
  { matches: true, conflicting: false, draft: false },
  { matches: false, conflicting: false, draft: false },
  { matches: true, conflicting: true, draft: false },
  { matches: true, conflicting: false, draft: true },
  {
    matches: true,
    conflicting: false,
    draft: false,
    url: "https://git.cafe/Owner/Repo/pulls/1",
    currentUrl: "https://git.cafe/owner/repo/pull/1",
  },
  {
    matches: true,
    conflicting: true,
    draft: false,
    url: "https://git.cafe/Owner/Repo/pulls/1",
    currentUrl: "https://git.cafe/owner/repo/pull/1",
  },
  { matches: false, conflicting: false, draft: false, checkoutPending: true },
  { matches: false, conflicting: true, draft: false, checkoutPending: true },
])("uses the matching checkout for PR tasks: %j", async (scenario) => {
  const { matches, conflicting, draft } = scenario;
  const checkoutPending = "checkoutPending" in scenario && scenario.checkoutPending;
  await using screen = await setup();
  state.status = "failure";
  state.conflicting = conflicting;
  if ("url" in scenario) state.url = scenario.url;
  const threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("existing-thread"),
  };
  const target = draft ? DraftId.make("existing-draft") : threadRef;
  useComposerDraftStore.getState().setPrompt(target, "Keep my notes");
  const render = (pending: boolean) => (
    <ThreadDetailsPrRow
      handoffDisabled={pending}
      environmentId={threadRef.environmentId}
      pr={null}
      number={1}
      status={null}
      project={null}
      label="Test PR"
      openAriaLabel="Open PR"
      onOpen={vi.fn()}
      currentThread={{
        target,
        pullRequestUrl:
          "currentUrl" in scenario
            ? scenario.currentUrl
            : `https://github.com/owner/repo/pull/${matches ? 1 : 2}`,
      }}
    />
  );
  await screen.rerender(render(checkoutPending));
  const button = screen.getByRole("button", { name: conflicting ? "Resolve" : "Fix", exact: true });
  if (checkoutPending) {
    await expect.element(button).toBeDisabled();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Keep my notes");
    expect(state.newThread).not.toHaveBeenCalled();
    await screen.rerender(render(false));
  }
  await button.click();
  if (matches) {
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(
        state.url,
      );
    });
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(
      "Keep my notes",
    );
    const detail = queryData();
    const task = conflicting
      ? buildResolveConflictsPrompt(detail)
      : buildFixFindingsHandoff({
          ...detail,
          reviewThreads: [],
          comments: [],
          commentsTruncated: false,
        }).prompt;
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(task);
    expect(state.newThread).not.toHaveBeenCalled();
    expect(state.prepareThread).not.toHaveBeenCalled();
  } else {
    await vi.waitFor(() => expect(state.prepareThread).toHaveBeenCalled());
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Keep my notes");
  }
});

async function setup() {
  state.perform.mockReset();
  state.checkoutError = null;
  state.newThread.mockReset().mockResolvedValue({
    draftId: DraftId.make("new-draft"),
    threadId: ThreadId.make("new-thread"),
  });
  state.prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      branch: "feature",
      worktreePath: "/workspace/pr",
      isOnPullRequestHead: true,
      pullRequest: { url: "https://github.com/owner/repo/pull/1" },
    },
  });
  state.addToast.mockReset().mockReturnValue("checkout-toast");
  state.updateToast.mockReset();

  state.status = "success";
  state.url = "https://github.com/owner/repo/pull/1";
  state.conflicting = false;
  state.extraStatus = null;
  state.mergeMethods = ["merge"];
  useUiStateStore.getState().setPullRequestMergeMethod("merge");
  return renderUi(null);
}
