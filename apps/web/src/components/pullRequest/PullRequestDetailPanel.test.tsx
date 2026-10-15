import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type PullRequestDetailView,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode, type ReactElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

const { newThread, prepareThread, refresh, Wrapper, Trigger } = vi.hoisted(() => ({
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  refresh: vi.fn(),
  Wrapper: ({ children }: { children?: ReactNode }) => children,
  Trigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("~/state/entities", () => ({ useProjects: () => [], useServerConfigs: () => new Map() }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("env-1"),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => true,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: prepareThread, isAllowed: true, error: null }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/pullRequests")>()),
  pullRequestEnvironment: {
    detail: () => "detail",
    activity: () => "activity",
    // The header menu reads the stored guide to label "Write guide" or "Rewrite guide".
    reviewGuide: () => "review-guide",
    generateReviewGuide: { permissionAtom: () => "generate-review-guide" },
  },
  usePullRequestTurnRefresh: () => 0,
  useSharedPullRequestSummary: () => null,
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { listRefs: () => null } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "detail" ? activeDetail : null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh,
  }),
}));
vi.mock("~/state/usePullRequestStack", () => ({
  usePullRequestStack: () => ({
    data: null,
    isSuccess: true,
    isPending: false,
    error: null,
    refresh,
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), update: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: Wrapper,
  Tooltip: Wrapper,
  TooltipTrigger: Trigger,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: Wrapper,
  MenuPopup: Wrapper,
  MenuTrigger: Trigger,
  MenuItem: "button",
  MenuRadioGroup: Wrapper,
  MenuRadioItem: "button",
  MenuSeparator: () => null,
  MenuShortcut: () => null,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: () => null,
  AlertDialogPopup: Wrapper,
  AlertDialogHeader: Wrapper,
  AlertDialogTitle: Wrapper,
  AlertDialogDescription: Wrapper,
  AlertDialogFooter: Wrapper,
  AlertDialogClose: Wrapper,
}));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdownContext: Wrapper,
  PullRequestMarkdown: () => null,
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./PullRequestThreadLinks", () => ({ PullRequestThreadLinks: () => null }));
vi.mock("./PullRequestSummaryTab", () => ({
  PullRequestSummaryTab: ({
    onFixFinding,
    scrollerRef,
  }: ComponentProps<typeof import("./PullRequestSummaryTab").PullRequestSummaryTab>) => (
    <div ref={scrollerRef} data-test-scroll="summary">
      <button
        onClick={() =>
          onFixFinding?.({
            kind: "check",
            check: { name: "Unit tests", status: "failure", description: "Test failed", url: null },
          })
        }
      >
        Fix check
      </button>
    </div>
  ),
}));
// Exercise the panel's handoffs without starting the diff worker.
vi.mock("./PullRequestGuideTab", () => ({
  PullRequestGuideTab: ({
    onAskAboutLines,
  }: ComponentProps<typeof import("./PullRequestGuideTab").PullRequestGuideTab>) => (
    <button
      onClick={() =>
        onAskAboutLines?.(
          {
            id: "pull-request-guide:b.ts:3:3",
            sectionId: "guide:b.ts",
            sectionTitle: "Review guide",
            filePath: "b.ts",
            startIndex: 2,
            endIndex: 2,
            rangeLabel: "L3",
            text: "Explain this guide line",
            diff: "+guide()",
          },
          "Explain this guide line",
        )
      }
    >
      Add guide comment
    </button>
  ),
}));
vi.mock("./PullRequestCodeTab", () => ({
  default: ({
    onAddToAgentSelection,
    scrollerRef,
  }: ComponentProps<typeof import("./PullRequestCodeTab").default>) => (
    <div ref={scrollerRef} data-test-scroll="code">
      {[1, 2].map((line) => (
        <button
          key={line}
          onClick={() =>
            onAddToAgentSelection?.({
              request: line === 1 ? "Fix this line" : "Fix the second line",
              comment: {
                id: `pull-request-selection:a.ts:${line}:${line}`,
                sectionId: "file:a.ts",
                sectionTitle: "a.ts",
                filePath: "a.ts",
                startIndex: line - 1,
                endIndex: line - 1,
                rangeLabel: `L${line}`,
                text: "Please fix",
                diff: "+broken()",
              },
            })
          }
        >
          {line === 1 ? "Add to agent" : "Add second comment"}
        </button>
      ))}
    </div>
  ),
}));

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import {
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  pullRequestPanelContext,
} from "./pullRequestDetail.logic";
import { usePullRequestHandoffs } from "./usePullRequestActions";
import {
  collectInlineContextIds,
  stripInlineContextReferences,
  insertInlineContextReference,
} from "~/lib/composerContextReferences";
import { reviewCommentContextId } from "~/lib/composerContextRecords";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
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
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
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

let activeDetail = detail;

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const draftId = DraftId.make("draft-1");
const newDraftId = DraftId.make("new-draft");
let renderer: ReactTestRenderer;

beforeEach(() => {
  activeDetail = detail;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  newThread
    .mockReset()
    .mockResolvedValue({ draftId: newDraftId, threadId: ThreadId.make("new-thread") });
  prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature", worktreePath: "/workspace/pr" },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

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

function addCommentAtCaret(target: ScopedThreadRef | DraftId, position: number) {
  const store = useComposerDraftStore.getState();
  const comment = {
    id: "file-comment:caret",
    sectionId: "file:caret.ts",
    sectionTitle: "caret.ts",
    filePath: "caret.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "L1",
    text: "Check this annotation",
    diff: "+const answer = 42;",
  };
  store.setContextInsertionHandler(target, (references) => {
    store.setPrompt(
      target,
      insertInlineContextReference(store.getComposerDraft(target)!.prompt, position, references[0]!)
        .prompt,
    );
    return true;
  });
  store.addReviewComment(target, comment);
  store.setContextInsertionHandler(target, null);
  return comment;
}

const actions = [
  "Resolve conflicts",
  "Ask a question",
  "Explain this PR",
  "Fix findings in this thread",
  "Fix check",
  "Add to agent",
];

// The surface ChatView opens for `detail`, and the thread states it can be opened beside. The
// context prop is derived here the way ChatView derives it, so a wrong answer from the thread's
// link list fails these cases rather than only a hand-picked prop.
const surface = { projectId: detail.projectId, repository: detail.repository, number: 1 };
const link = (number: number, source: ThreadPullRequestLink["source"]): ThreadPullRequestLink => ({
  host: "github.com",
  repository: detail.repository,
  number,
  url: `https://github.com/${detail.repository}/pull/${number}`,
  source,
  linkedAt: "2026-09-01T00:00:00Z",
  snapshot: null,
  stack: null,
});
const stackThread = {
  projectId: detail.projectId,
  pullRequests: [link(3, "manual"), link(2, "stack"), link(1, "stack")],
  // The server's one-slot field names the top layer; the panel shows the bottom one.
  linkedPullRequest: { ...surface, number: 3, url: link(3, "manual").url },
};
const unrelatedThread = {
  projectId: detail.projectId,
  pullRequests: [link(9, "created")],
  linkedPullRequest: { ...surface, number: 9, url: link(9, "created").url },
};

describe.each([
  ["own PR, a lower layer of the thread's stack", stackThread, threadRef],
  ["another PR beside the current thread", unrelatedThread, threadRef],
  ["PR beside an unsent draft", null, draftId],
  ["standalone PR page", null, undefined],
] as const)("%s", (_name, thread, target) => {
  const context = thread ? pullRequestPanelContext(thread, surface) : "page";

  function panel(reference = detail) {
    return (
      <PullRequestDetailPanel
        environmentId={threadRef.environmentId}
        reference={reference}
        context={context}
        {...(target ? { composerDraftTarget: target, threadRef } : {})}
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
    );
  }

  function render() {
    renderer = create(panel());
  }

  it(`${thread === stackThread ? "hides" : "offers"} the checkout`, async () => {
    await act(async () => render());
    const checkout = renderer.root
      .findAllByType("button")
      .filter((node) => node.props["aria-label"] === "Check out");
    expect(checkout).toHaveLength(thread === stackThread ? 0 : 1);
  });

  it.each(actions)("%s writes to the correct composer", async (action) => {
    if (target) useComposerDraftStore.getState().setPrompt(target, "Keep my draft");
    await act(async () => render());
    if (action === "Add to agent") await click("Code");
    await click(target ? action : action.replace("in this thread", "in a thread"));
    const draft = useComposerDraftStore.getState().getComposerDraft(target ?? newDraftId);
    if (action === "Resolve conflicts") expect(draft?.prompt).toContain("resolve every conflict");
    else if (action === "Fix check") expect(draft?.prompt).toContain("Fix the failing check");
    else if (action.startsWith("Fix findings"))
      expect(draft?.prompt).toContain("Fix the actionable findings");
    else expect(draft?.reviewComments?.length).toBeGreaterThan(0);
    if (action === "Add to agent") {
      expect(draft?.prompt).toContain("Fix this line");
      expect(draft?.reviewComments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filePath: "a.ts", rangeLabel: "L1", diff: "+broken()" }),
        ]),
      );
    }
    if (target) {
      expect(draft?.prompt).toContain("Keep my draft");
      expect(newThread).not.toHaveBeenCalled();
      expect(prepareThread).not.toHaveBeenCalled();
    } else {
      expect(newThread).toHaveBeenCalled();
    }
  });

  if (target) {
    it.each([
      ["Code", "Add to agent", "Guide", "Add guide comment"],
      ["Guide", "Add guide comment", "Code", "Add to agent"],
    ])(
      "preserves line citations from %s (%s) and %s (%s)",
      async (firstTab, firstAction, secondTab, secondAction) => {
        await act(async () => render());
        await click(firstTab);
        await click(firstAction);
        const first = useComposerDraftStore.getState().getComposerDraft(target)!;
        await click(secondTab);
        await click(secondAction);
        const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
        expect(draft.prompt).toContain(first.prompt);
        expect(draft.prompt).toContain("Fix this line");
        expect(draft.prompt).toContain("Explain this guide line");
        expect(draft.prompt).toContain("[a.ts L1](t3-context://v1/review-comment/");
        expect(draft.prompt).toContain("[b.ts L3](t3-context://v1/review-comment/");
      },
    );

    it.each([
      ["Explain this PR", "Ask a question", "Explain this pull request.", ""],
      ["Fix check", "Explain this PR", "Fix the failing check", "Explain this pull request."],
    ])(
      "replaces %s with %s after appending line comments",
      async (first, second, obsolete, incoming) => {
        const store = useComposerDraftStore.getState();
        store.setPrompt(target, "Keep my draft");
        await act(async () => render());
        await click(first);
        await click("Code");
        await click("Add to agent");
        await click("Guide");
        await click("Add guide comment");
        const before = store.getComposerDraft(target)!;
        const selections = before.reviewComments.filter((comment) => comment.diff.length > 0);
        await click(second);
        const draft = store.getComposerDraft(target)!;
        expect(draft.prompt).not.toContain(obsolete);
        expect(draft.prompt).toContain("Keep my draft");
        expect(draft.prompt).toContain("Fix this line");
        expect(draft.prompt).toContain("Explain this guide line");
        if (incoming) expect(draft.prompt).toContain(incoming);
        for (const selection of selections) {
          expect(draft.reviewComments).toContainEqual(selection);
          expect(collectInlineContextIds(draft.prompt)).toContain(
            reviewCommentContextId(selection.id),
          );
        }
      },
    );

    it("keeps edits to a general request when replacing it after a line comment", async () => {
      const store = useComposerDraftStore.getState();
      await act(async () => render());
      await click("Explain this PR");
      store.setPrompt(
        target,
        store
          .getComposerDraft(target)!
          .prompt.replace(
            "Explain this pull request.",
            "Explain this pull request, especially the cache.",
          ),
      );
      await click("Code");
      await click("Add to agent");
      await click("Ask a question");
      const draft = store.getComposerDraft(target)!;
      expect(draft.prompt).toContain("Explain this pull request, especially the cache.");
      expect(draft.prompt).toContain("Fix this line");
      expect(draft.prompt).toContain("[a.ts L1](t3-context://v1/review-comment/");
    });

    it.each(["", "Explain this pull request.\n\nKeep preceding note."])(
      "removes the generated request while keeping identical reader paragraphs after %s",
      async (prefix) => {
        const store = useComposerDraftStore.getState();
        store.setPrompt(target, prefix);
        await act(async () => render());
        await click("Explain this PR");
        store.setPrompt(
          target,
          `${store.getComposerDraft(target)!.prompt}\n\nKeep this note.\n\nExplain this pull request.`,
        );
        await click("Ask a question");
        const prompt = store.getComposerDraft(target)!.prompt;
        expect(prompt).toContain(
          `${prefix ? `${prefix}\n\n` : ""}Keep this note.\n\nExplain this pull request.`,
        );
        if (!prefix) expect(prompt.startsWith("Keep this note.")).toBe(true);
      },
    );

    it.each([false, true])(
      "preserves ambiguous earlier copies (including citation: %s)",
      async (copyCitation) => {
        const store = useComposerDraftStore.getState();
        store.setPrompt(target, "Keep my draft");
        await act(async () => render());
        await click("Explain this PR");
        const original = store.getComposerDraft(target)!.prompt;
        const request = "Explain this pull request.";
        const copied = copyCitation ? original.slice("Keep my draft\n\n".length) : request;
        store.setPrompt(
          target,
          original.replace(request, `${copied}\n\nKeep this note.\n\n${request}`),
        );
        await click("Ask a question");
        const prompt = store.getComposerDraft(target)!.prompt;
        expect(prompt.match(/Explain this pull request\./gu)).toHaveLength(2);
        expect(stripInlineContextReferences(prompt)).toContain(
          `${request}${copyCitation ? " " : ""}\n\nKeep this note.\n\n${request}`,
        );
      },
    );

    it("preserves indentation and trailing spaces around the replaced request", async () => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(target, "Keep my draft  ");
      await act(async () => render());
      await click("Explain this PR");
      store.setPrompt(
        target,
        `${store.getComposerDraft(target)!.prompt}\n\n    const answer = 42;  \n\treturn answer;`,
      );
      await click("Ask a question");
      expect(store.getComposerDraft(target)!.prompt).toContain(
        "Keep my draft  \n\n    const answer = 42;  \n\treturn answer;",
      );
    });

    it.each([0, "Keep my draft\n\n".length, "Keep my draft\n\nExplain this pull request.".length])(
      "replaces its request after a caret citation at %s",
      async (position) => {
        const store = useComposerDraftStore.getState();
        store.setPrompt(target, "Keep my draft");
        await act(async () => render());
        await click("Explain this PR");
        store.setPrompt(
          target,
          `${store.getComposerDraft(target)!.prompt}\n\nKeep this note.\n\nExplain this pull request.`,
        );
        const comment = addCommentAtCaret(target, position);
        await click("Ask a question");
        const draft = store.getComposerDraft(target)!;
        expect(draft.prompt.match(/Explain this pull request\./gu)).toHaveLength(1);
        expect(draft.prompt).toContain("Keep this note.\n\nExplain this pull request.");
        expect(draft.prompt).toContain("Keep my draft");
        expect(draft.reviewComments).toContainEqual(comment);
        expect(collectInlineContextIds(draft.prompt)).toContain(reviewCommentContextId(comment.id));
      },
    );

    it("replaces Explain with Ask without accumulating general context chips", async () => {
      await act(async () => render());
      await click("Explain this PR");
      await click("Ask a question");
      const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
      expect(draft.prompt).not.toContain("Explain this pull request.");
      expect(draft.reviewComments).toHaveLength(1);
      expect(draft.reviewComments[0]?.text).toContain("Answer the question");
      expect(collectInlineContextIds(draft.prompt)).toHaveLength(1);
    });

    it.each([
      ["another PR", "https://github.com/owner/repo/pull/2", 2],
      ["another repository", "https://github.com/other/repo/pull/1", 1],
      ["another host", "https://git.example.com/owner/repo/pull/1", 1],
    ])("keeps the same selected range from %s", async (_name, url, number) => {
      const store = useComposerDraftStore.getState();
      await act(async () => render());
      await click("Code");
      await click("Add to agent");
      const first = store.getComposerDraft(target)!;
      activeDetail = {
        ...detail,
        url,
        number,
        repository: url.includes("other/") ? "other/repo" : detail.repository,
      };
      await act(async () => renderer.update(panel(activeDetail)));
      await click("Add to agent");
      const draft = store.getComposerDraft(target)!;
      expect(draft.reviewComments).toHaveLength(4);
      expect(new Set(draft.reviewComments.map((comment) => comment.id)).size).toBe(4);
      for (const comment of first.reviewComments) {
        expect(draft.reviewComments).toContainEqual(comment);
        expect(collectInlineContextIds(draft.prompt)).toContain(reviewCommentContextId(comment.id));
      }
      expect(
        draft.reviewComments
          .filter((comment) => comment.pullRequest)
          .map((comment) => comment.pullRequest?.url),
      ).toEqual([detail.url, url]);
    });

    it("preserves both comments and their citations when adding a second line comment", async () => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(target, "Keep my draft");
      await act(async () => render());
      await click("Code");
      await click("Add to agent");
      const firstPrompt = store.getComposerDraft(target)?.prompt;
      expect(firstPrompt).toContain("Fix this line");
      expect(firstPrompt).toContain("[a.ts L1](t3-context://v1/review-comment/");

      await click("Add second comment");
      const draft = store.getComposerDraft(target);
      expect(draft?.prompt).toContain(firstPrompt);
      expect(draft?.prompt).toContain("Fix the second line");
      expect(draft?.prompt).toContain("[a.ts L2](t3-context://v1/review-comment/");
      expect(draft?.reviewComments?.map((comment) => comment.filePath)).toEqual([
        "a.ts",
        "PR #1",
        "a.ts",
      ]);
    });
  }
});

function QuickActions() {
  const handoffs = usePullRequestHandoffs({ environmentId: threadRef.environmentId, detail });
  return (
    <>
      <button onClick={() => handoffs.startAsk("explain", buildExplainPullRequestHandoff(detail))}>
        Explain this PR
      </button>
      <button onClick={() => handoffs.startAsk("ask", buildAskAboutPullRequestHandoff(detail))}>
        Ask a question
      </button>
    </>
  );
}

it("preserves reader copies and indentation through PR row quick actions", async () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(newDraftId, "Keep my draft  ");
  await act(async () => {
    renderer = create(<QuickActions />);
  });
  await click("Explain this PR");
  store.setPrompt(
    newDraftId,
    `${store.getComposerDraft(newDraftId)!.prompt}\n\n    const answer = 42;\n\nExplain this pull request.`,
  );
  await click("Ask a question");
  expect(store.getComposerDraft(newDraftId)!.prompt).toContain(
    "Keep my draft  \n\n    const answer = 42;\n\nExplain this pull request.",
  );
});

it.each([0, "Keep my draft\n\n".length, "Keep my draft\n\nExplain this pull request.".length])(
  "replaces PR-row requests after a caret citation at %s",
  async (position) => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(newDraftId, "Keep my draft");
    await act(async () => {
      renderer = create(<QuickActions />);
    });
    await click("Explain this PR");
    const comment = addCommentAtCaret(newDraftId, position);
    await click("Ask a question");
    const draft = store.getComposerDraft(newDraftId)!;
    expect(draft.prompt).not.toContain("Explain this pull request.");
    expect(draft.prompt).toContain("Keep my draft");
    expect(draft.reviewComments).toContainEqual(comment);
    expect(collectInlineContextIds(draft.prompt)).toContain(reviewCommentContextId(comment.id));
  },
);

it("preserves an earlier reader copy through PR-row quick actions", async () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(newDraftId, "Keep my draft");
  await act(async () => {
    renderer = create(<QuickActions />);
  });
  await click("Explain this PR");
  const request = "Explain this pull request.";
  store.setPrompt(
    newDraftId,
    store
      .getComposerDraft(newDraftId)!
      .prompt.replace(request, `${request}\n\nKeep this note.\n\n${request}`),
  );
  await click("Ask a question");
  const prompt = store.getComposerDraft(newDraftId)!.prompt;
  expect(prompt.match(/Explain this pull request\./gu)).toHaveLength(2);
  expect(prompt).toContain(`${request}\n\nKeep this note.\n\n${request}`);
});

it("changes the title only for the active tab's main scroller", async () => {
  const scrollers = new Map<string, { scrollTop: number; scrollHeight: number }>();
  await act(async () => {
    renderer = create(
      <PullRequestDetailPanel
        environmentId={threadRef.environmentId}
        reference={detail}
        context="page"
        shortcutsEnabled={false}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
      />,
      {
        createNodeMock: (element) => {
          const props = element.props as Record<string, unknown>;
          const name = props["data-test-scroll"] as string | undefined;
          if (name) {
            const scroller = { scrollTop: 0, scrollHeight: 300 };
            scrollers.set(name, scroller);
            return scroller;
          }
          return { scrollHeight: props.inert === false ? 100 : 20 };
        },
      },
    );
  });

  const mainScroll = renderer.root.findByProps({
    className: "relative flex min-h-0 flex-1 flex-col overflow-hidden",
  });
  const titleFold = () => {
    let node = renderer.root.findByType("h1");
    while (typeof node.props.inert !== "boolean") node = node.parent!;
    return node;
  };
  const summary = scrollers.get("summary")!;
  const nested = { scrollTop: 200 };
  await act(async () => mainScroll.props.onScrollCapture({ target: nested }));
  expect(titleFold().props.inert).toBe(false);
  summary.scrollTop = 180;
  nested.scrollTop = 0;
  await act(async () => {
    mainScroll.props.onScrollCapture({ target: summary });
    mainScroll.props.onScrollCapture({ target: nested });
  });
  expect(titleFold().props.inert).toBe(true);
  expect(summary.scrollTop).toBe(100);
  expect(nested.scrollTop).toBe(0);

  await act(async () => mainScroll.props.onScrollCapture({ target: { scrollTop: 0 } }));
  expect(titleFold().props.inert).toBe(true);
  summary.scrollTop = 0;
  await act(async () => mainScroll.props.onScrollCapture({ target: summary }));
  expect(titleFold().props.inert).toBe(false);

  await click("Code");
  const code = scrollers.get("code")!;
  summary.scrollTop = 180;
  await act(async () => mainScroll.props.onScrollCapture({ target: summary }));
  expect(titleFold().props.inert).toBe(false);
  code.scrollTop = 180;
  await act(async () => mainScroll.props.onScrollCapture({ target: code }));
  expect(titleFold().props.inert).toBe(true);
  expect(code.scrollTop).toBe(100);
  await click("Summary");
  expect(titleFold().props.inert).toBe(false);
  await click("Code");
  expect(titleFold().props.inert).toBe(true);
  code.scrollTop = 0;
  await act(async () => mainScroll.props.onScrollCapture({ target: code }));
  expect(titleFold().props.inert).toBe(false);
});
