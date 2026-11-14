import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestCheck,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DraftId } from "~/composerDraftStore";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
  mergeMethods: ["merge"] as Array<"merge" | "squash" | "rebase">,
  perform: vi.fn(),
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  checkoutError: null as Error | null,
  addToast: vi.fn(),
  updateToast: vi.fn(),
  projects: [] as unknown[],
  pullRequests: [] as unknown[],
  projectMergeMethods: {} as Record<string, "merge" | "squash" | "rebase">,
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
  useProjects: (() => state.projects) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null ? null : { branch: null, pullRequests: state.pullRequests }) as never,
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
  usePullRequestDefaultMergeMethodResolver: ((_environmentId: unknown, projectId: unknown) => () =>
    state.projectMergeMethods[String(projectId)]) as never,
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
import { useComposerDraftStore } from "~/composerDraftStore";
import { useUiStateStore } from "~/uiStateStore";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const scratchProject = {
  id: ProjectId.make("scratch"),
  environmentId: EnvironmentId.make("environment"),
  title: "No project",
  workspaceRoot: "/home/user/.t3/scratch",
  scripts: [],
};
const repositoryProject = {
  id: ProjectId.make("repository"),
  environmentId: EnvironmentId.make("environment"),
  title: "repo",
  workspaceRoot: "/work/repo",
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/owner/repo.git",
    },
    provider: SourceControlProviderKind.make("github"),
    owner: "owner",
    name: "repo",
    displayName: "owner/repo",
  },
};

const clickButton = async (scope: ParentNode, label: string) =>
  await act(async () => {
    [...scope.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === label)!
      .click();
  });

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
  state.mergeMethods = ["merge"];
  state.projects = [];
  state.pullRequests = [];
  state.projectMergeMethods = {};
  useComposerDraftStore.getState().clearComposerContent(threadRef);
  useUiStateStore.getState().setPullRequestMergeMethod("merge");
  return renderUi(null);
}

it("adds the failing checks to a given composer instead of opening a new thread", async () => {
  await using screen = await setup();
  state.status = "failure";
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
        composerTarget={threadRef}
      />,
    );
  });
  await clickButton(screen.container, "Fix");
  expect(state.newThread).not.toHaveBeenCalled();
  expect(state.prepareThread).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toContain(
    "https://github.com/owner/repo/pull/1",
  );
});

const repositoryClone = {
  ...repositoryProject,
  id: ProjectId.make("clone"),
  workspaceRoot: "/work/clone",
};

it.each([
  {
    name: "the project holding its repository, not the No project thread's",
    thread: scratchProject,
    repository: "owner/repo",
    expected: "rebase",
  },
  {
    name: "the thread's own project when it holds the repository too",
    thread: repositoryClone,
    repository: "owner/repo",
    expected: "merge",
  },
  {
    name: "the thread's project when no project holds the repository",
    thread: scratchProject,
    repository: "owner/other",
    expected: "squash",
  },
])("merges a linked pull request with $name", async ({ thread, repository, expected }) => {
  await using screen = await setup();
  state.mergeMethods = ["merge", "squash", "rebase"];
  state.projects = [scratchProject, repositoryProject, repositoryClone];
  state.projectMergeMethods = { scratch: "squash", repository: "rebase", clone: "merge" };
  useUiStateStore.getState().setPullRequestMergeMethod("squash");
  state.pullRequests = [
    {
      host: "github.com",
      repository,
      number: 1,
      url: `https://github.com/${repository}/pull/1`,
      source: "manual",
      linkedAt: "2026-10-30T00:00:00.000Z",
      snapshot: null,
      stack: null,
    },
  ];
  await act(async () => {
    await screen.rerender(
      <ThreadDetailsThreadPrRows threadRef={threadRef} project={thread as never} />,
    );
  });
  await clickButton(screen.container, "Merge");
  expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
    `using ${expected}`,
  );
});
