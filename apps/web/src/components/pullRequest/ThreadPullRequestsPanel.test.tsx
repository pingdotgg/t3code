import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ThreadPullRequestsPanel } from "./ThreadPullRequestsPanel";

const { shell, tracker, capabilities, update, openIssue, openInBrowser, modifiers, perform } =
  vi.hoisted(() => ({
    shell: vi.fn(),
    tracker: vi.fn((_reference: unknown): unknown => null),
    capabilities: vi.fn(() => ({ threadPullRequests: true, issues: true })),
    update: vi.fn(async () => ({ _tag: "Success" })),
    openIssue: vi.fn(),
    openInBrowser: vi.fn(),
    modifiers: vi.fn(() => ({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false })),
    perform: vi.fn(),
  }));
vi.mock("~/shortcutModifierState", () => ({ useShortcutModifierState: modifiers }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("./usePullRequestActions", () => ({
  usePullRequestActionRunner: () => ({ actionPending: false, perform }),
  usePullRequestDefaultMergeMethodResolver: () => () => undefined,
}));
const project = (id: string, environmentId: string, host: string, repository: string) => ({
  id,
  environmentId,
  repositoryIdentity: {
    provider: "github",
    canonicalKey: `${host}/${repository.toLowerCase()}`,
    displayName: repository,
  },
});
vi.mock("~/state/entities", () => ({
  useThreadShell: shell,
  useProjects: () => [
    project("project-1", "remote", "github.com", "acme/app"),
    project("project-2", "remote", "github.com", "Acme/Api"),
    project("elsewhere", "local", "github.acme.test", "acme/app"),
  ],
  useServerConfigs: () => new Map([["remote", { environment: { capabilities: capabilities() } }]]),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (reference: unknown) => ({
    data: tracker(reference),
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { detail: ({ input }: { input: unknown }) => input, invalidate: null },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => update }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ openIssue }) } }));
vi.mock("~/lib/openIssueLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/openIssueLink")>()),
  openLinkInBrowser: openInBrowser,
}));
vi.mock("~/lib/openPullRequestLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/openPullRequestLink")>()),
  shouldOpenPullRequestExternally: () => false,
  useOpenPrLink: () => vi.fn(),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open === false ? null : children,
  MenuItem: "button",
  MenuPopup: "div",
  MenuTrigger: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: ({ render, children }: { render?: ReactElement; children: ReactNode }) =>
    render ? cloneElement(render, undefined, children) : <span>{children}</span>,
  TooltipPopup: "span",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/middle-truncate", () => ({ MiddleTruncate: () => null }));
const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const issue = {
  provider: "github",
  repository: "acme/app",
  number: 12,
  title: "Fix refresh",
  url: "https://github.com/acme/app/issues/12",
};
const otherProject = {
  ...issue,
  repository: "acme/api",
  number: 3,
  url: "https://github.com/acme/api/issues/3",
};
const pullRequest = {
  host: "github.com",
  repository: "acme/app",
  number: 24,
  url: "https://github.com/acme/app/pull/24",
  source: "manual",
  linkedAt: "2026-10-07T00:00:00Z",
  snapshot: null,
  stack: null,
} satisfies ThreadPullRequestLink;
const enterprise = { ...issue, url: "https://github.acme.test/acme/app/issues/12" };
const linear = {
  ...issue,
  provider: "linear",
  repository: "ENG",
  url: "https://linear.app/acme/issue/ENG-12",
};
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
  tracker.mockReturnValue(null);
  capabilities.mockReturnValue({ threadPullRequests: true, issues: true });
  modifiers.mockReturnValue({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
});

async function render(issues: ReadonlyArray<typeof issue & { projectId?: string }>) {
  shell.mockReturnValue({ projectId: "project-1", pullRequests: [], issues });
  await act(() => {
    renderer = create(<ThreadPullRequestsPanel threadRef={ref} />);
  });
}

async function click(url: string) {
  const link = renderer.root.find((node) => node.type === "a" && node.props.href === url);
  await act(() => link.props.onClick({ preventDefault: vi.fn() }));
}

function answerWith(issues: ReadonlyArray<typeof issue>) {
  const answers = issues.map((saved) => ({ ...saved, title: saved.url, state: "open" }));
  tracker.mockImplementation((reference) => {
    const { provider, repository, number } = reference as typeof issue;
    return answers.find(
      (answer) =>
        answer.provider === provider &&
        answer.repository === repository &&
        answer.number === number,
    );
  });
}

async function clickTree(url: string) {
  const row = renderer.root.find(
    (node) =>
      node.type === "button" &&
      node.props.role === "treeitem" &&
      node.findAll((child) => child.children.includes(url)).length > 0,
  );
  await act(() => row.props.onClick());
}

it("opens each issue in the project its URL names, and Linear in the thread's project", async () => {
  answerWith([issue, otherProject, linear]);
  await render([issue, otherProject, linear]);
  await clickTree(otherProject.url);
  await clickTree(linear.url);
  expect(openIssue.mock.calls).toEqual([
    [
      ref,
      {
        projectId: "project-2",
        provider: "github",
        repository: "acme/api",
        number: 3,
      },
    ],
    [
      ref,
      {
        projectId: "project-1",
        provider: "linear",
        repository: "ENG",
        number: 12,
      },
    ],
  ]);
  expect(openInBrowser).not.toHaveBeenCalled();
});

it("explains that both kinds of linked items are unavailable", async () => {
  capabilities.mockReturnValue({ threadPullRequests: false, issues: false });
  await render([]);
  expect(
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .some((node) =>
        node.children.includes("This environment does not support linked pull requests or issues."),
      ),
  ).toBe(true);
});

it("keeps the saved source project for Linear", async () => {
  answerWith([linear]);
  await render([{ ...linear, projectId: "project-2" }]);
  await clickTree(linear.url);
  expect(openIssue).toHaveBeenCalledWith(ref, {
    projectId: "project-2",
    provider: "linear",
    repository: "ENG",
    number: 12,
  });
});

it("opens a link with a missing source project in the browser", async () => {
  await render([{ ...linear, projectId: "missing" }]);
  await click(linear.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledWith(linear.url);
});

it("opens an issue from a host no project in this environment uses in the browser", async () => {
  await render([enterprise]);
  await click(enterprise.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledWith(enterprise.url);
});

it("lists issues on servers that support issues but not multiple pull requests", async () => {
  capabilities.mockReturnValue({ threadPullRequests: false, issues: true });
  answerWith([issue]);
  await render([issue]);
  await clickTree(issue.url);
  expect(openIssue).toHaveBeenCalledOnce();
});

it("opens a saved issue in the browser when the tracker answers with another one", async () => {
  tracker.mockReturnValue({
    ...linear,
    title: "Other workspace",
    url: "https://linear.app/other/issue/ENG-12",
    state: "open",
  });
  await render([linear]);
  expect(renderer.root.findAll((node) => node.props.role === "treeitem")).toEqual([]);
  await click(linear.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(linear.url);
});

it("opens a saved issue whose tree could not be read in the browser", async () => {
  await render([issue]);
  await click(issue.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(issue.url);
});

it("opens issues in the browser when the server cannot read them", async () => {
  capabilities.mockReturnValue({ threadPullRequests: true, issues: false });
  await render([issue]);
  await click(issue.url);
  expect(openIssue).not.toHaveBeenCalled();
  expect(openInBrowser).toHaveBeenCalledWith(issue.url);
});

it("unlinks an issue by its host identity", async () => {
  await render([issue, enterprise]);
  expect(
    renderer.root
      .findAllByType("button")
      .some((node) => node.children.includes("Unlink from thread")),
  ).toBe(false);
  const row = renderer.root.find(
    (node) => node.type === "a" && node.props.href === enterprise.url,
  ).parent!;
  await act(() =>
    row.props.onContextMenu({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 50,
      clientY: 80,
    }),
  );
  const unlink = renderer.root.find(
    (node) => node.type === "button" && node.children.includes("Unlink from thread"),
  );
  await act(() => unlink.props.onClick());
  expect(update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: {
      threadId: "thread-1",
      issueUnlink: { provider: "github", repository: "acme/app", number: 12, url: enterprise.url },
    },
  });
});

it("opens PR row actions on right-click and keeps PR unlinking", async () => {
  shell.mockReturnValue({ projectId: "project-1", pullRequests: [pullRequest], issues: [issue] });
  await act(() => {
    renderer = create(<ThreadPullRequestsPanel threadRef={ref} />);
  });
  expect(
    renderer.root
      .findAllByType("button")
      .some((node) => node.children.includes("Unlink from thread")),
  ).toBe(false);
  const row = renderer.root.find(
    (node) => node.type === "a" && node.props.href === pullRequest.url,
  ).parent!;
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 40, clientY: 60 };
  await act(() => row.props.onContextMenu(event));
  expect(event.preventDefault).toHaveBeenCalledOnce();
  const unlink = renderer.root.find(
    (node) => node.type === "button" && node.children.includes("Unlink from thread"),
  );
  await act(() => unlink.props.onClick());
  expect(update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: { threadId: "thread-1", host: "github.com", repository: "acme/app", number: 24 },
  });
});

it.each([
  ["open", false, ["Close", "Merge"], "close"],
  ["open", true, ["Close", "Ready for review"], "close"],
  ["closed", false, ["Reopen"], "reopen"],
  ["merged", false, [], null],
] as const)(
  "keeps fast PR actions beside issue links (%s, draft %s)",
  async (state, isDraft, labels, action) => {
    capabilities.mockImplementation(() => ({
      threadPullRequests: true,
      issues: true,
      pullRequests: true,
    }));
    modifiers.mockReturnValue({ shiftKey: true, metaKey: false, ctrlKey: false, altKey: false });
    const linked = {
      ...pullRequest,
      snapshot: {
        state,
        title: "Fix the app",
        headBranch: "feature",
        baseBranch: "main",
        isDraft,
        updatedAt: null,
        syncedAt: "2026-10-07T00:00:00Z",
      },
    } satisfies ThreadPullRequestLink;
    shell.mockReturnValue({ projectId: "project-1", pullRequests: [linked], issues: [issue] });
    answerWith([issue]);
    await act(() => {
      renderer = create(<ThreadPullRequestsPanel threadRef={ref} />);
    });
    const buttons = renderer.root
      .findAllByType("button")
      .filter((button) =>
        ["Close #24", "Merge #24", "Ready for review #24", "Reopen #24"].includes(
          button.props["aria-label"],
        ),
      );
    expect(buttons.map((button) => button.props["aria-label"])).toEqual(
      labels.map((label) => `${label} #24`),
    );
    if (action !== null) {
      await act(() => buttons[0]!.props.onClick());
      expect(perform).toHaveBeenCalledExactlyOnceWith(action);
    }
    await clickTree(issue.url);
    expect(openIssue).toHaveBeenCalledWith(ref, {
      projectId: "project-1",
      provider: "github",
      repository: "acme/app",
      number: 12,
    });
  },
);
