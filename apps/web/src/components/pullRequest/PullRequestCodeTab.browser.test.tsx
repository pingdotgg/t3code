import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

const { diffAtom, pagedDiffAtom, latePage } = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const filePatch = (path: string) =>
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,6 +1,6 @@",
      "-before()",
      "+after()",
      " one()",
      " two()",
      " three()",
      " four()",
      " five()",
      "",
    ].join("\n");
  const firstPage: PullRequestDiffResult = {
    patch: filePatch("a.ts"),
    truncated: false,
    nextCursor: null,
  };
  const pages: Record<string, PullRequestDiffResult> = {
    first: {
      patch: Array.from({ length: 40 }, (_, index) =>
        filePatch(index === 1 ? "early-1.test.ts" : `early-${index}.ts`),
      ).join(""),
      truncated: true,
      nextCursor: "page-2",
    },
    "page-2": { patch: filePatch("late.test.ts"), truncated: false, nextCursor: null },
  };
  return {
    // An environment query whose refetch returns equal content hands back the previous value
    // itself, so a refresh publishes a new result around the very same page.
    latePage: pages["page-2"]!,
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
        AsyncResult.success(pages[cursor]!),
      ),
    ),
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  viewer: "alice",
  diffCommits: [] as Array<string | undefined>,
  viewedPaths: null as ReadonlySet<string> | null,
  viewedListeners: new Set<() => void>(),
}));

function deliverViewedPaths(paths: ReadonlySet<string> | null) {
  mocks.viewedPaths = paths;
  for (const listener of mocks.viewedListeners) listener();
}

vi.mock(import("./usePullRequestReviewKey"), async () => {
  const { pullRequestReviewKey } = await import("./pullRequestReviewStore");
  const key = (
    environmentId: EnvironmentId,
    reference: { projectId: ProjectId; repository: string; number: number },
  ) => pullRequestReviewKey(reference, { environmentId, viewer: mocks.viewer });
  return {
    usePullRequestReviewKey: key,
    usePullRequestReviewScope: (
      environmentId: EnvironmentId,
      reference: { projectId: ProjectId; repository: string; number: number },
    ) => ({ key: key(environmentId, reference), ready: true }),
  };
});

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock(import("./usePullRequestFilesViewed"), async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.viewedListeners.add(listener);
    return () => mocks.viewedListeners.delete(listener);
  };
  return {
    usePullRequestFilesViewed: () => {
      const viewedPaths = useSyncExternalStore(subscribe, () => mocks.viewedPaths);
      return {
        ready: true,
        filePaths: viewedPaths === null ? null : [...viewedPaths],
        viewedCount: viewedPaths?.size ?? 0,
        enabled: viewedPaths !== null,
        isViewed: (path: string) => viewedPaths?.has(path) === true,
        isStale: () => false,
        setViewed: () => {},
        truncated: false,
        error: null,
        refresh: () => {},
      };
    },
  };
});
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diff: (({ input }: { input: { cursor?: string; commit?: string } }) => {
        mocks.diffCommits.push(input.commit);
        return mocks.paged ? pagedDiffAtom(input.cursor ?? "first") : diffAtom;
      }) as never,
    },
  };
});

import { render } from "../../../test/render";
import PullRequestCodeTab from "./PullRequestCodeTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
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
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

function setup({ paged }: { paged: boolean }) {
  window.localStorage.removeItem("t3code.diffHideTestFiles");
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  mocks.paged = paged;
  mocks.viewer = "alice";
  mocks.diffCommits = [];
  mocks.viewedPaths = null;
  mocks.viewedListeners.clear();
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
  revealUrl?: string,
  onRevealSettled?: (url: string) => void,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={detail}
    selectedCommitOid={null}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
    revealRequest={revealRequest}
    revealUrl={revealUrl}
    onRevealSettled={onRevealSettled}
  />
);

it("keeps the diff after a refresh that brings back the same page", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  await screen.rerender(tab(1));

  await expect
    .element(screen.getByText("This pull request has no file changes."))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

// regression: #13279 a Viewed answer that lands after a link reveals a file must not fold it
it("keeps a revealed file open when its Viewed mark loads afterwards", async () => {
  setup({ paged: false });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  using _preferences = {
    [Symbol.dispose]() {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  mocks.viewedPaths = new Set();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0, { path: "a.ts", nonce: 1 }), { container });
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();

  deliverViewedPaths(new Set(["a.ts"]));
  await expect.element(screen.getByRole("checkbox", { name: "Viewed" })).toBeChecked();

  await expect
    .element(screen.getByRole("button", { name: "Collapse diff" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
});

function pagedContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  return container;
}

async function expectFileHeaderShown(
  screen: Awaited<ReturnType<typeof render>>,
  container: HTMLElement,
  path: string,
) {
  const header = screen.getByText(path, { exact: true }).first();
  await expect.element(header).toBeInTheDocument();
  await vi.waitFor(() => {
    const bounds = container.querySelector(".diff-render-surface")!.getBoundingClientRect();
    const { top, bottom } = header.element().getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(bounds.top);
    expect(bottom).toBeLessThanOrEqual(bounds.bottom);
  });
}

it("scrolls to a file asked for as the tab opens", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0, { path: "early-39.ts", nonce: 1 }), { container });

  await expectFileHeaderShown(screen, container, "early-39.ts");
});

it.each([false, true])(
  "pages forward to a file asked for that is not loaded yet, then scrolls to it (grouped: %s)",
  async (groupByType) => {
    setup({ paged: true });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      diffFilesCollapsed: true,
      pullRequestViewing: { ...DEFAULT_CLIENT_SETTINGS.pullRequestViewing, groupByType },
    });
    using _preferences = {
      [Symbol.dispose]() {
        window.localStorage.removeItem("t3code.diffHideTestFiles");
        __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
      },
    };
    const container = pagedContainer();
    await using screen = await render(tab(0), { container });
    await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();
    await screen.getByRole("button", { name: "Hide test files" }).click();

    const url = `${detail.url}/files#diff-${bytesToHex(sha256(new TextEncoder().encode("late.test.ts")))}R4-R5`;
    const settled = vi.fn();
    await screen.rerender(tab(0, null, url, settled));

    await expectFileHeaderShown(screen, container, "late.test.ts");
    await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
    // A settled link keeps its test file past the filter, and a later click reveals it again.
    await screen.rerender(tab(0, { path: "early-0.ts", nonce: 1 }));
    await expectFileHeaderShown(screen, container, "early-0.ts");
    await screen.rerender(tab(0, { path: "early-0.ts", nonce: 1 }, url, settled));
    await expectFileHeaderShown(screen, container, "late.test.ts");
  },
);

it.each(["gone", "kept..newer"])(
  "validates the selected commit scope %s against the pull request",
  async (selection) => {
    setup({ paged: false });
    const container = document.createElement("div");
    container.className = "flex h-[700px] w-[900px]";
    // The timeline can open a commit that a force-push removed from the pull request.
    await using screen = await render(
      <PullRequestCodeTab
        scrollerRef={() => {}}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        detail={{
          ...detail,
          commits: [
            {
              oid: "newer",
              messageHeadline: "Newer commit",
              committedDate: "2026-09-02T00:00:00Z",
            },
            {
              oid: "kept",
              messageHeadline: "Kept commit",
              committedDate: "2026-09-01T00:00:00Z",
            },
          ],
        }}
        selectedCommitOid={selection}
        onSelectedCommitChange={() => {}}
        onRefresh={() => {}}
      />,
      { container },
    );

    await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
    await expect
      .element(
        screen.getByRole("button", {
          name: selection === "gone" ? "Diff scope: All commits" : "Diff scope: 2 commits",
        }),
      )
      .toBeVisible();
    expect(mocks.diffCommits).not.toContain("gone");
    if (selection !== "gone") expect(mocks.diffCommits).toContain(selection);
  },
);
it("answers a commit's diff link only once that commit's diff is shown", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const oid = "c".repeat(40);
  const withCommit = {
    ...detail,
    commits: [{ oid, messageHeadline: "Linked commit", committedDate: "2026-09-01T00:00:00Z" }],
  };
  const url = `${detail.url}/commits/${oid}#diff-${bytesToHex(sha256(new TextEncoder().encode("a.ts")))}R2`;
  const settled = vi.fn();
  const scoped = (selectedCommitOid: string | null, revealUrl?: string) => (
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={withCommit}
      selectedCommitOid={selectedCommitOid}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
      revealUrl={revealUrl}
      onRevealSettled={settled}
    />
  );
  await using screen = await render(scoped(null), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  // The panel selects the link's commit after this tab has already seen the link.
  await screen.rerender(scoped(null, url));
  expect(settled).not.toHaveBeenCalled();
  await screen.rerender(scoped(oid, url));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
});

it("hides a resolved conversation behind avatars on its line until they are clicked", async () => {
  setup({ paged: false });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  using _preferences = {
    [Symbol.dispose]() {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const comment = {
    author: { login: "reviewer", name: null, avatarUrl: null },
    body: "Rename this.",
    createdAt: "2026-09-01T00:00:00Z",
    url: null,
  };
  const withThread = (isResolved: boolean, oldSideToo = false, revealed = false) => (
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      revealRequest={revealed ? { path: "a.ts", threadId: "thread", nonce: 1 } : null}
      detail={{
        ...detail,
        capabilities: {
          ...detail.capabilities,
          review: { ...detail.capabilities.review, reply: true },
        },
        viewerPermissions: { ...detail.viewerPermissions, comment: true },
        reviewThreads: [
          {
            id: "thread",
            path: "a.ts",
            line: 3,
            side: "right",
            isResolved,
            isOutdated: false,
            comments: [{ id: "comment", ...comment }],
          },
          ...(oldSideToo
            ? [
                {
                  id: "old-side",
                  path: "a.ts",
                  line: 3,
                  side: "left" as const,
                  isResolved: true,
                  isOutdated: false,
                  comments: [{ id: "old-side-comment", ...comment }],
                },
              ]
            : []),
        ],
      }}
      selectedCommitOid={null}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />
  );
  await using screen = await render(withThread(true), { container });
  const marker = screen.getByRole("button", { name: "Resolved conversation", exact: true });
  const card = (state: string) => screen.getByRole("button", { name: `${state} · 1 comment` });
  const reply = () => screen.getByRole("textbox", { name: "Reply to this conversation" });

  await expect.element(marker).toHaveAttribute("aria-expanded", "false");
  await expect.element(card("Resolved")).not.toBeInTheDocument();

  await screen.rerender(withThread(true, false, true));
  await expect.element(marker).toHaveAttribute("aria-expanded", "true");
  await expect.element(card("Resolved")).toHaveAttribute("aria-expanded", "true");
  await screen.rerender(withThread(true));
  await expect.element(card("Resolved")).toBeVisible();
  await screen.getByRole("button", { name: "Reply", exact: true }).click();
  await reply().fill("Unsent");

  // Hidden conversations stay mounted, so the unsent reply is still there.
  await marker.click();
  await expect.element(card("Resolved")).not.toBeInTheDocument();
  await marker.click();
  await expect.element(reply()).toHaveValue("Unsent");
  await marker.click();

  // Seen open and then resolved, it stays until the avatars are clicked.
  await screen.rerender(withThread(false));
  await expect.element(card("Open")).toBeVisible();
  await screen.rerender(withThread(true));
  await expect.element(card("Resolved")).toBeVisible();

  // Stacked view draws a context row once, so both sides' conversations share the avatars.
  await screen.rerender(withThread(true, true));
  await expect
    .element(screen.getByRole("button", { name: "2 resolved conversations" }))
    .toBeVisible();
});

it("waits for a pending diff page before answering a conversation reveal", async () => {
  setup({ paged: true });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using _pendingPage = { [Symbol.dispose]: registry.mount(pagedDiffAtom("page-2")) };
  registry.set(pagedDiffAtom("page-2"), AsyncResult.initial(true));
  const container = pagedContainer();
  const ui = (reveal: boolean) => (
    <RegistryContext.Provider value={registry}>
      <PullRequestCodeTab
        scrollerRef={() => {}}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        detail={{
          ...detail,
          reviewThreads: [
            {
              id: "late-thread",
              path: "late.test.ts",
              line: 3,
              side: "right",
              isResolved: false,
              isOutdated: false,
              comments: [
                {
                  id: "late-comment",
                  author: { login: "reviewer", name: null, avatarUrl: null },
                  body: "Conversation on a later page",
                  createdAt: "2026-09-01T00:00:00Z",
                  url: null,
                },
              ],
            },
          ],
        }}
        selectedCommitOid={null}
        onSelectedCommitChange={() => {}}
        onRefresh={() => {}}
        revealRequest={
          reveal ? { path: "late.test.ts", threadId: "late-thread", line: 3, nonce: 1 } : null
        }
      />
    </RegistryContext.Provider>
  );
  await using screen = await render(ui(false), { container });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();
  await screen.rerender(ui(true));
  expect(registry.get(pagedDiffAtom("page-2")).waiting).toBe(true);
  await expect
    .element(screen.getByRole("button", { name: /Conversations not on the diff loaded so far/ }))
    .toHaveAttribute("aria-expanded", "false");
  registry.set(pagedDiffAtom("page-2"), AsyncResult.success(latePage));
  await expectFileHeaderShown(screen, container, "late.test.ts");
  await expect.element(screen.getByText("Conversation on a later page")).toBeVisible();
});

it("sends a selected line to an agent when the host cannot accept inline comments", async () => {
  setup({ paged: false });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  const addToAgent = vi.fn();
  const container = pagedContainer();
  await using screen = await render(
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={detail}
      selectedCommitOid={null}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
      onAddToAgentSelection={addToAgent}
    />,
    { container },
  );
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
  const root = screen.getByText("three()", { exact: true }).element().getRootNode() as ShadowRoot;
  const gutter = root.querySelector<HTMLElement>('[data-column-number="4"]')!;
  await userEvent.click(page.elementLocator(gutter));
  await expect
    .element(screen.getByRole("button", { name: "Add to agent", exact: true }))
    .toBeVisible();
  await screen.getByRole("textbox").fill("Explain this line");
  await screen.getByRole("button", { name: "Add to agent", exact: true }).click();
  expect(addToAgent).toHaveBeenCalledWith(
    expect.objectContaining({ request: "Explain this line" }),
  );
});

it("closes a mounted inline draft when its acting account changes", async () => {
  setup({ paged: false });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  const container = pagedContainer();
  const ui = () => (
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={{
        ...detail,
        capabilities: {
          ...detail.capabilities,
          review: { ...detail.capabilities.review, inlineComment: true },
        },
        viewerPermissions: { ...detail.viewerPermissions, comment: true },
      }}
      selectedCommitOid={null}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
      onAddToAgentSelection={() => {}}
    />
  );
  await using screen = await render(ui(), { container });
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
  const root = screen.getByText("three()", { exact: true }).element().getRootNode() as ShadowRoot;
  await userEvent.click(
    page.elementLocator(root.querySelector<HTMLElement>('[data-column-number="4"]')!),
  );
  await screen.getByRole("textbox").fill("Alice private inline feedback");
  mocks.viewer = "bob";
  await screen.rerender(ui());
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Add to review", exact: true }))
    .not.toBeInTheDocument();
});
