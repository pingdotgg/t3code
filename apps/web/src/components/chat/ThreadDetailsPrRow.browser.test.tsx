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
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
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

import { act, render as renderUi } from "../../../test/render";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

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

it.each<[PullRequestCheck["status"], PullRequestCheck["status"], string]>([
  ["success", "skipped", ""],
  ["failure", "cancelled", ""],
  ["success", "action-required", "1/2"],
  ["success", "pending", "1/2"],
  ["pending", "pending", "0/2"],
  ["pending", "action-required", "0/2"],
  ["skipped", "pending", "1/2"],
  ["neutral", "pending", "1/2"],
  ["failure", "pending", "1/2"],
  ["cancelled", "pending", "1/2"],
])("counts finished checks while work remains (%s, %s)", async (status, extraStatus, count) => {
  await using screen = await setup();
  const { container } = screen;
  state.status = status;
  state.extraStatus = extraStatus;
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
  const counts = [...container.querySelectorAll("*")]
    .map((element) => element.textContent?.trim() ?? "")
    .filter((value) => /^\d+\/\d+$/.test(value));
  expect(new Set(counts)).toEqual(new Set(count ? [count] : []));
});

it("shows the current checkout recovery detail when fixing checks fails and is retried", async () => {
  await using screen = await setup();
  const { container } = screen;
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

it("splits the change by file kind in the hover card", async () => {
  await using screen = await setup();
  await screen.rerender(
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("environment")}
      pr={null}
      number={1}
      reference={{ repository: "owner/repo", number: 1 }}
      status={null}
      project={{ id: ProjectId.make("project"), repositoryIdentity: null } as never}
      label="Test PR"
      openAriaLabel="Open PR"
      onOpen={vi.fn()}
    />,
  );
  await userEvent.hover(screen.getByRole("button", { name: "Open PR" }));
  await expect
    .poll(() => document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent)
    .toMatch(/Docs\+7-3/);
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
  return renderUi(null);
}
