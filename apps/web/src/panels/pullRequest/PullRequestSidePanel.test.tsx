import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestDetailView,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, Suspense, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";

const { bodyImport, capabilities, Wrapper, Trigger } = vi.hoisted(() => ({
  // Holds the body's code until a test lets it arrive, like a slow first chunk load.
  bodyImport: (() => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve: () => resolve() };
  })(),
  // Pull request capability per environment; null means its server config has not arrived.
  capabilities: new Map<string, boolean | null>(),
  Wrapper: ({ children }: { children?: ReactNode }) => children,
  Trigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
const configFor = (environmentId: string) => {
  const pullRequests = capabilities.get(environmentId);
  return pullRequests == null
    ? null
    : { environment: { capabilities: { pullRequests, threadPullRequests: pullRequests } } };
};
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("~/state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () =>
    new Map(
      [...capabilities.keys()].map((environmentId) => [environmentId, configFor(environmentId)]),
    ),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: (environmentId: string) => {
    const serverConfig = configFor(environmentId);
    return serverConfig ? { serverConfig } : null;
  },
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-new"),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  useEnvironmentSettings: () => undefined,
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: vi.fn() }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/pullRequests")>()),
  pullRequestEnvironment: { detail: () => "detail", activity: () => "activity" },
  usePullRequestTurnRefresh: () => 0,
  useSharedPullRequestSummary: () => null,
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { listRefs: () => null } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "detail" ? detail : null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/usePullRequestStack", () => ({
  usePullRequestStack: () => ({
    data: { layers: [] },
    isSuccess: true,
    isPending: false,
    isFresh: true,
    error: null,
    notice: null,
    refresh: vi.fn(),
  }),
}));
// The stack menu's popup is chrome; its layer row is the entry point under test.
vi.mock("~/components/pullRequest/PullRequestStackMenu", () => ({
  PullRequestStackMenu: ({
    reference,
    onSelect,
  }: ComponentProps<
    typeof import("~/components/pullRequest/PullRequestStackMenu").PullRequestStackMenu
  >) => <button onClick={() => onSelect?.({ ...reference, number: 8 })}>Open #8</button>,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn(), update: vi.fn() } }));
vi.mock("~/components/ui/tooltip", () => ({
  TooltipProvider: Wrapper,
  Tooltip: Wrapper,
  TooltipTrigger: Trigger,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: Wrapper,
  MenuPopup: Wrapper,
  MenuTrigger: Trigger,
  MenuItem: "button",
  MenuRadioGroup: Wrapper,
  MenuRadioItem: "button",
  MenuSeparator: () => null,
  MenuShortcut: () => null,
}));
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: () => null,
  AlertDialogPopup: Wrapper,
  AlertDialogHeader: Wrapper,
  AlertDialogTitle: Wrapper,
  AlertDialogDescription: Wrapper,
  AlertDialogFooter: Wrapper,
  AlertDialogClose: Wrapper,
}));
vi.mock("~/components/pullRequest/PullRequestMarkdown", () => ({
  PullRequestMarkdownContext: Wrapper,
  PullRequestMarkdown: () => null,
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/components/pullRequest/PullRequestThreadLinks", () => ({
  PullRequestThreadLinks: () => null,
}));
vi.mock("~/components/pullRequest/PullRequestSummaryTab", () => ({
  PullRequestSummaryTab: () => null,
}));
vi.mock("~/components/pullRequest/PullRequestCodeTab", () => ({ default: () => null }));
vi.mock("./PullRequestSidePanel", async (importOriginal) => {
  await bodyImport.promise;
  return importOriginal();
});

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

const detail: PullRequestDetailView = {
  provider: "github",
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 7,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/7",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    stacks: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

// The same thread id on two environments is two threads.
const threadId = ThreadId.make("thread-a");
const refOn = (environmentId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId,
});
const reference = { projectId: detail.projectId, repository: detail.repository, number: 7 };
let renderer: ReactTestRenderer;

// Lets the body's code arrive and settles it before rendering, so mounts finish inside one act().
async function loadBody() {
  bodyImport.resolve();
  await import("./PullRequestSidePanel");
}

async function renderFor(threadRef: ScopedThreadRef) {
  const host: PanelHost = {
    threadRef,
    visible: true,
    composerDraftTarget: threadRef,
    workspaceMutationId: null,
    sendAnnotation: () => undefined,
  };
  await act(async () => {
    renderer = create(
      <PanelHostContext value={host}>
        <Suspense fallback={null}>
          <RegisteredSidePanel
            id="pull-request"
            reference={reference}
            context="thread"
            shortcutsEnabled={false}
            getShortcutContext={() => ({
              terminalFocus: false,
              terminalOpen: false,
              previewFocus: false,
              previewOpen: false,
              isWeb: true,
              isDesktop: false,
            })}
          />
        </Suspense>
      </PanelHostContext>,
    );
  });
}

const hasText = (text: string) =>
  renderer.root.findAll((node) => node.children.includes(text)).length > 0;

async function click(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        node.props["aria-label"] === label ||
        node.findAll((child) => child.children.includes(label)).length > 0,
    );
  expect(button, label).toBeDefined();
  await act(async () =>
    button!.props.onClick({
      nativeEvent: new Event("click"),
      preventDefault() {},
      stopPropagation() {},
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  capabilities.clear();
  capabilities.set("environment-old", false);
  capabilities.set("environment-new", true);
  capabilities.set("environment-loading", null);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

const isLoading = () =>
  renderer.root.findAll(
    (node) => node.props.role === "status" && node.props["aria-label"] === "Loading pull request",
  ).length > 0;

describe("pull request side panel", () => {
  // Runs first, while the body's code is still held back.
  it("shows the pull request loading state until its code arrives", async () => {
    await renderFor(refOn("environment-new"));
    expect(isLoading()).toBe(true);
    expect(hasText("Test pull request")).toBe(false);

    await act(loadBody);
    expect(isLoading()).toBe(false);
    expect(hasText("Test pull request")).toBe(true);
    await click("Ask a question");
    expect(
      useComposerDraftStore.getState().getComposerDraft(refOn("environment-new"))?.reviewComments,
    ).toHaveLength(1);
  });

  it("follows the host environment's pull request support", async () => {
    await loadBody();
    await renderFor(refOn("environment-loading"));
    expect(isLoading()).toBe(true);
    expect(hasText("Test pull request")).toBe(false);
    expect(hasText("Pull requests unavailable")).toBe(false);

    await renderFor(refOn("environment-old"));
    expect(hasText("Pull requests unavailable")).toBe(true);
    expect(hasText("Update this environment's T3 Code server to browse pull requests.")).toBe(true);
    expect(hasText("Test pull request")).toBe(false);

    await renderFor(refOn("environment-new"));
    expect(hasText("Test pull request")).toBe(true);
  });

  it("writes a question into the host thread's composer only", async () => {
    await loadBody();
    const threadRef = refOn("environment-new");
    useComposerDraftStore.getState().setPrompt(threadRef, "Keep my draft");
    await renderFor(threadRef);
    await click("Ask a question");
    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.prompt).toContain("Keep my draft");
    expect(draft?.reviewComments?.length).toBeGreaterThan(0);
    expect(useComposerDraftStore.getState().getComposerDraft(refOn("environment-old"))).toBeNull();
  });

  it("opens a stack layer as a tab in the host's own thread", async () => {
    await loadBody();
    const threadRef = refOn("environment-new");
    await renderFor(threadRef);
    await click("Open #8");
    const { byThreadKey } = useRightPanelStore.getState();
    expect(byThreadKey[scopedThreadKey(threadRef)]?.surfaces).toMatchObject([
      { kind: "pull-request", repository: "owner/repo", number: 8 },
    ]);
    expect(byThreadKey[scopedThreadKey(refOn("environment-old"))]).toBeUndefined();
  });
});
