import {
  EnvironmentId,
  GitCommandError,
  GitManagerError,
  ProjectId,
  ThreadId,
  type PullRequestCheck,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { DraftId } from "~/composerDraftStore";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
  perform: vi.fn(),
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  checkoutError: null as Error | null,
  addToast: vi.fn(),
  updateToast: vi.fn(),
  serverConfigs: new Map() as Map<unknown, unknown>,
  stackError: null as string | null,
  refreshStack: vi.fn(),
  runStackAction: vi.fn(),
  stackRefreshing: false,
  stack: null as null | {
    readonly id: string;
    readonly number: number;
    readonly url: string;
    readonly base: string;
    readonly layers: ReadonlyArray<{
      number: number;
      headBranch: string;
      headSha: string;
      state: "open" | "merged";
    }>;
  },
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useServerConfigs: (() => state.serverConfigs) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.runStackAction) as never,
}));
vi.mock(import("~/state/usePullRequestStack"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePullRequestStackGate: (() => ({
    stack: {
      data: state.stack,
      isFresh: state.stackError === null,
      isPending: state.stackRefreshing,
      error: state.stackError,
      refresh: state.refreshStack,
    },
    supportsStackActions: state.stack !== null || state.stackError !== null,
    canMergeSinglePullRequest: state.stack === null && state.stackError === null,
  })) as never,
}));
const queryData = () => ({
  projectId: ProjectId.make("project"),
  workspaceRoot: "/workspace",
  url: "https://github.com/owner/repo/pull/1",
  number: 1,
  title: "Test PR",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
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
  capabilities: { actions: ["merge"], mergeMethods: ["merge"] },
  viewerPermissions: { actions: ["merge"] },
  mergeCapabilities: { merge: true, squash: false, rebase: false },
});
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuerySelector: ((_atom: unknown, select: (result: unknown) => unknown) =>
    select(AsyncResult.success(queryData()))) as never,
  useEnvironmentQueryIsNewer: () => true,
  useEnvironmentQueryRefresh: () => ({ refresh: vi.fn(), isPending: () => false }),
}));
vi.mock(import("../pullRequest/usePullRequestActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
}));

vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => state.newThread) as never,
}));
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
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

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.checkoutError = null;
  state.newThread.mockReset().mockResolvedValue({
    draftId: DraftId.make("new-draft"),
    threadId: ThreadId.make("new-thread"),
  });
  state.prepareThread.mockReset();
  state.addToast.mockReset().mockReturnValue("checkout-toast");
  state.updateToast.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  state.status = "success";
  state.extraStatus = null;
  state.serverConfigs = new Map();
  state.stack = null;
  state.stackError = null;
  state.stackRefreshing = false;
  state.refreshStack.mockReset();
});

it("offers a retry instead of a dead end when the stack lookup fails", () => {
  state.stackError = "GitHub stack lookup failed";
  act(() =>
    root.render(
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
    ),
  );
  const labels = [...container.querySelectorAll("button")].map((button) =>
    button.textContent?.trim(),
  );
  expect(labels).not.toContain("Merge");
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Retry stack")!
      .click(),
  );
  expect(state.refreshStack).toHaveBeenCalledTimes(1);
});

it("offers to merge a stacked pull request only with its whole stack", async () => {
  state.runStackAction.mockReset().mockResolvedValue({ _tag: "Success" });
  const environmentId = EnvironmentId.make("environment");
  state.serverConfigs = new Map([
    [environmentId, { environment: { capabilities: { pullRequests: true } } }],
  ]);
  state.stack = {
    id: "stack",
    number: 7,
    url: "https://github.com/owner/repo/stacks/7",
    base: "main",
    layers: [
      { number: 1, headBranch: "feature", headSha: "a1", state: "open" },
      { number: 2, headBranch: "feature-2", headSha: "b2", state: "open" },
    ],
  };
  act(() =>
    root.render(
      <ThreadDetailsPrRow
        environmentId={environmentId}
        pr={null}
        number={1}
        reference={{ host: "github.com", repository: "owner/repo", number: 1 }}
        status={null}
        project={{ id: ProjectId.make("project") } as never}
        label="Test PR"
        openAriaLabel="Open PR"
        onOpen={vi.fn()}
      />,
    ),
  );
  const labels = [...container.querySelectorAll("button")].map((button) =>
    button.textContent?.trim(),
  );
  expect(labels).toContain("Merge stack");
  expect(labels).not.toContain("Merge");

  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Merge stack")!
      .click(),
  );
  expect(document.body.textContent).toContain("Merge 2 pull requests?");

  // A stale stack would replay old layer heads on the next attempt, so every stack result
  // must refresh the stack lookup.
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.trim() === "Merge stack")!
      .click(),
  );
  expect(state.runStackAction).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ number: 2, stackNumber: 7, action: "merge" }),
    }),
  );
  expect(state.refreshStack).toHaveBeenCalledTimes(1);

  // Until that refresh lands, the old layers must not be offered for another merge.
  state.stackRefreshing = true;
  act(() =>
    root.render(
      <ThreadDetailsPrRow
        environmentId={environmentId}
        pr={null}
        number={1}
        reference={{ host: "github.com", repository: "owner/repo", number: 1 }}
        status={null}
        project={{ id: ProjectId.make("project") } as never}
        label="Test PR"
        openAriaLabel="Open PR"
        onOpen={vi.fn()}
      />,
    ),
  );
  const mergeStack = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Merge stack",
  );
  expect(mergeStack?.disabled).toBe(true);
});

it("requires a new merge click after passing checks become pending and pass again", () => {
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
  const clickMerge = () =>
    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Merge")!
        .click();
    });
  const dialogs = () => [...document.querySelectorAll('[role="alertdialog"]')];

  act(() => root.render(render()));
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  act(() => {
    state.status = "pending";
    root.render(render());
  });
  expect(dialogs()).toHaveLength(0);
  act(() => {
    state.status = "success";
    root.render(render());
  });
  expect(dialogs()).toHaveLength(0);
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  expect(state.perform).not.toHaveBeenCalled();
});

it.each<[PullRequestCheck["status"], PullRequestCheck["status"], string]>([
  ["success", "skipped", ""],
  ["failure", "cancelled", ""],
  ["success", "action-required", ""],
  ["success", "pending", "1/2"],
  ["failure", "pending", "1/2"],
])("shows a count only while checks run (%s, %s)", (status, extraStatus, count) => {
  state.status = status;
  state.extraStatus = extraStatus;
  act(() => {
    root.render(
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
  const counts = [...container.querySelectorAll("*")]
    .map((element) => element.textContent?.trim() ?? "")
    .filter((value) => /^\d+\/\d+$/.test(value));
  expect(new Set(counts)).toEqual(new Set(count ? [count] : []));
});

it("shows the current checkout recovery detail when fixing checks fails and is retried", async () => {
  state.status = "failure";
  const first = new GitManagerError({
    cwd: "/workspace",
    operation: "preparePullRequestThread",
    detail: "This PR branch is already checked out in the main repo. Use Local.",
  });
  const second = new GitCommandError({
    cwd: "/workspace",
    operation: "GitVcsDriver.createWorktree",
    command: "git worktree add",
    detail: "The worktree directory already exists. Choose another directory.",
  });
  await act(async () => {
    root.render(
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

  for (const error of [first, second]) {
    state.prepareThread.mockImplementationOnce(async () => {
      state.checkoutError = error;
      return { _tag: "Failure", cause: Cause.fail(error) };
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Fix")!
        .click();
    });
  }
  expect(state.updateToast.mock.calls.map(([, toast]) => toast.description)).toEqual([
    expect.stringContaining(first.detail),
    second.detail,
  ]);
});
