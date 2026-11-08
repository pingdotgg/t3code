import { EnvironmentId, ProjectId, ThreadId, type PullRequestCheck } from "@t3tools/contracts";
import { DraftId } from "~/composerDraftStore";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
  autoMergeEnabled: false as boolean | undefined,
  canMergeNow: undefined as boolean | undefined,
  actions: ["merge"] as Array<"merge" | "enable-auto-merge">,
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
  autoMergeEnabled: state.autoMergeEnabled,
  canMergeNow: state.canMergeNow,
  capabilities: { actions: state.actions, mergeMethods: state.mergeMethods },
  viewerPermissions: { actions: state.actions },
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

it("hides Merge once auto-merge is armed", async () => {
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
  await act(async () => await screen.rerender(render()));
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Merge",
    ),
  ).toBe(true);
  await act(async () => {
    state.autoMergeEnabled = true;
    await screen.rerender(render());
  });
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Merge",
    ),
  ).toBe(false);
});

it("offers enable auto-merge while checks are pending", async () => {
  await using screen = await setup();
  const { container } = screen;
  state.status = "pending";
  state.actions = ["merge", "enable-auto-merge"];
  useUiStateStore.getState().setPullRequestMergeMethod("squash");
  state.mergeMethods = ["merge", "squash"];
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
  const clickEnable = async (scope: ParentNode) =>
    await act(async () => {
      [...scope.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Enable auto-merge")!
        .click();
    });
  await clickEnable(container);
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("not right away");
  await clickEnable(dialog);
  expect(state.perform).toHaveBeenCalledWith("enable-auto-merge", "squash");
});

it("offers enable auto-merge when branch rules block even if checks pass", async () => {
  await using screen = await setup();
  const { container } = screen;
  state.canMergeNow = false;
  state.actions = ["merge", "enable-auto-merge"];
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
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Enable auto-merge",
    ),
  ).toBe(true);
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Merge",
    ),
  ).toBe(false);
});

async function setup() {
  state.perform.mockReset();
  state.checkoutError = null;
  state.newThread.mockReset().mockResolvedValue({
    draftId: DraftId.make("new-draft"),
    threadId: ThreadId.make("new-thread"),
  });
  state.prepareThread.mockReset();
  state.addToast.mockReset().mockReturnValue("checkout-toast");
  state.updateToast.mockReset();

  state.status = "success";
  state.extraStatus = null;
  state.autoMergeEnabled = false;
  state.canMergeNow = undefined;
  state.actions = ["merge"];
  state.mergeMethods = ["merge"];
  useUiStateStore.getState().setPullRequestMergeMethod("merge");
  return renderUi(null);
}
