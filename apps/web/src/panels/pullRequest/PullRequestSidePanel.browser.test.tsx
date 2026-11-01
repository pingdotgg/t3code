import { act, render as renderScreen, type Screen } from "../../../test/render";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { use, Suspense, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: { configValueAtom: () => null },
    primaryServerKeybindingsAtom: {},
  };
});
vi.mock("~/state/entities", () => ({
  readProjects: () => [],
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
vi.mock("~/commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/state/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: vi.fn() }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", () => ({
  newestPullRequestSummary: (current: unknown, observed: unknown) => observed ?? current,
  pullRequestListEntryToSummary: () => null,
  pullRequestEnvironment: {
    detail: () => "detail",
    changeBreakdown: () => "change-breakdown",
    activity: () => "activity",
    reviewGuide: () => "review-guide",
    generateReviewGuide: { permissionAtom: () => "generate-review-guide" },
  },
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
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn(), update: vi.fn() },
  stackedThreadToast: vi.fn(),
}));
vi.mock("~/components/ui/tooltip", () => ({
  TooltipProvider: Wrapper,
  Tooltip: Wrapper,
  TooltipTrigger: Trigger,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: Wrapper,
  MenuPopup: Wrapper,
  MenuGroup: Wrapper,
  MenuTrigger: Trigger,
  MenuItem: "button",
  MenuCheckboxItem: "button",
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
vi.mock("~/components/pullRequest/PullRequestGuideTab", () => ({
  PullRequestGuideTab: () => null,
}));
vi.mock("./PullRequestSidePanel", async (importOriginal) => {
  const { default: Body } = await importOriginal<typeof import("./PullRequestSidePanel")>();
  return {
    default: function DeferredBody(props: ComponentProps<typeof Body>) {
      use(bodyImport.promise);
      return <Body {...props} />;
    },
  };
});

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
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

// Lets the body's code arrive and settles it before rendering, so mounts finish inside one act().
async function loadBody() {
  bodyImport.resolve();
  await import("./PullRequestSidePanel");
}

async function renderFor(screen: Screen, threadRef: ScopedThreadRef) {
  const host: PanelHost = {
    threadRef,
    visible: true,
    composerDraftTarget: threadRef,
    workspaceMutationId: null,
    sendAnnotation: () => undefined,
  };
  await screen.rerender(
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
}

const hasText = (screen: Screen, text: string) =>
  screen.container.textContent?.includes(text) ?? false;

async function click(screen: Screen, label: string) {
  const button = Array.from(screen.container.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.includes(label),
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

const isLoading = (screen: Screen) =>
  screen.container.querySelector('[role="status"][aria-label="Loading pull request"]') !== null;

describe("pull request side panel", () => {
  // Runs first, while the body's code is still held back.
  it("shows the pull request loading state until its body is ready", async () => {
    resetFixture();
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
    await using screen = await renderScreen(null, { router: false });
    await renderFor(screen, refOn("environment-new"));
    expect(isLoading(screen)).toBe(true);
    expect(hasText(screen, "Test pull request")).toBe(false);

    await act(loadBody);
    expect(isLoading(screen)).toBe(false);
    expect(hasText(screen, "Test pull request")).toBe(true);
    await click(screen, "Ask a question");
    expect(
      useComposerDraftStore.getState().getComposerDraft(refOn("environment-new"))?.reviewComments,
    ).toHaveLength(1);
  });

  it("follows the host environment's pull request support", async () => {
    resetFixture();
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
    await using screen = await renderScreen(null, { router: false });
    await loadBody();
    await renderFor(screen, refOn("environment-loading"));
    expect(isLoading(screen)).toBe(true);
    expect(hasText(screen, "Test pull request")).toBe(false);
    expect(hasText(screen, "Pull requests unavailable")).toBe(false);

    await renderFor(screen, refOn("environment-old"));
    expect(hasText(screen, "Pull requests unavailable")).toBe(true);
    expect(
      hasText(screen, "Update this environment's T3 Code server to browse pull requests."),
    ).toBe(true);
    expect(hasText(screen, "Test pull request")).toBe(false);

    await renderFor(screen, refOn("environment-new"));
    expect(hasText(screen, "Test pull request")).toBe(true);
  });

  it("writes a question into the host thread's composer only", async () => {
    resetFixture();
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
    await using screen = await renderScreen(null, { router: false });
    await loadBody();
    const threadRef = refOn("environment-new");
    useComposerDraftStore.getState().setPrompt(threadRef, "Keep my draft");
    await renderFor(screen, threadRef);
    await click(screen, "Ask a question");
    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.prompt).toContain("Keep my draft");
    expect(draft?.reviewComments?.length).toBeGreaterThan(0);
    expect(useComposerDraftStore.getState().getComposerDraft(refOn("environment-old"))).toBeNull();
  });

  it("opens a stack layer as a tab in the host's own thread", async () => {
    resetFixture();
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
    await using screen = await renderScreen(null, { router: false });
    await loadBody();
    const threadRef = refOn("environment-new");
    await renderFor(screen, threadRef);
    await click(screen, "Open #8");
    const { byThreadKey } = useRightPanelStore.getState();
    expect(byThreadKey[scopedThreadKey(threadRef)]?.surfaces).toMatchObject([
      { kind: "pull-request", repository: "owner/repo", number: 8 },
    ]);
    expect(byThreadKey[scopedThreadKey(refOn("environment-old"))]).toBeUndefined();
  });
});

function resetFixture() {
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
}
