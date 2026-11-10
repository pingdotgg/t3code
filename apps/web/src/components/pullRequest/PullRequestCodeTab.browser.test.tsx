import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

import "~/index.css";

const { diffAtom, pagedDiffAtom, mixedDiffAtom } = await vi.hoisted(async () => {
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
      patch: Array.from({ length: 40 }, (_, index) => filePatch(`early-${index}.ts`)).join(""),
      truncated: true,
      nextCursor: "page-2",
    },
    "page-2": { patch: filePatch("late.ts"), truncated: false, nextCursor: null },
  };
  return {
    // An environment query whose refetch returns equal content hands back the previous value
    // itself, so a refresh publishes a new result around the very same page.
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    mixedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() =>
        AsyncResult.success<PullRequestDiffResult>(
          cursor === "first"
            ? { ...firstPage, nextCursor: "raw-page" }
            : { patch: "The host omitted this patch.", truncated: false, nextCursor: null },
        ),
      ),
    ),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() => AsyncResult.success(pages[cursor]!)),
    ),
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  raw: false,
  diffCommits: [] as Array<string | undefined>,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diff: (({ input }: { input: { cursor?: string; commit?: string } }) => {
        mocks.diffCommits.push(input.commit);
        if (mocks.raw) return mixedDiffAtom(input.cursor ?? "first");
        return mocks.paged ? pagedDiffAtom(input.cursor ?? "first") : diffAtom;
      }) as never,
    },
  };
});

import { render } from "../../../test/render";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
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

function setup({ paged, raw = false }: { paged: boolean; raw?: boolean }) {
  mocks.paged = paged;
  mocks.raw = raw;
  mocks.diffCommits = [];
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
  details: PullRequestDetailView = detail,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={details}
    selectedCommitOid={null}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
    revealRequest={revealRequest}
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

function hideFiles(patterns: string, hidden = true) {
  const key = "t3code.diffHideTestFiles";
  const previousSettings = getClientSettings();
  const previousHidden = getLocalStorageItem(key, Schema.Boolean);
  __setClientSettingsForTests({ ...previousSettings, diffHideFilePatterns: patterns });
  setLocalStorageItem(key, hidden, Schema.Boolean);
  return {
    [Symbol.dispose]() {
      __setClientSettingsForTests(previousSettings);
      if (previousHidden === null) removeLocalStorageItem(key);
      else setLocalStorageItem(key, previousHidden, Schema.Boolean);
    },
  };
}

it.each([false, true])(
  "keeps conversations when all files are hidden (raw fallback: %s)",
  async (raw) => {
    setup({ paged: false, raw });
    using _settings = hideFiles("^a\\.ts$");
    const container = document.createElement("div");
    container.className = "h-[700px] w-[900px]";
    const details: PullRequestDetailView = {
      ...detail,
      reviewThreads: [
        {
          id: "thread-1",
          path: "a.ts",
          line: 1,
          side: "right",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "comment-1",
              author: detail.author,
              body: "Keep this review conversation",
              createdAt: detail.createdAt,
              url: null,
            },
          ],
        },
      ],
    };
    await using screen = await render(tab(0, null, details), { container });

    await expect.element(screen.getByText("All matching files are hidden.")).toBeVisible();
    await screen.getByRole("button", { name: /Conversations not on the current diff/ }).click();
    await expect.element(screen.getByText("Keep this review conversation")).toBeVisible();
    if (raw) await expect.element(screen.getByText("The host omitted this patch.")).toBeVisible();
    await expect
      .element(screen.getByText("This pull request has no file changes."))
      .not.toBeInTheDocument();

    await screen.getByRole("button", { name: "1 matching file hidden" }).click();

    await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("a.ts", { exact: true }).first()).toBeVisible();
    await expect
      .element(screen.getByText("All matching files are hidden."))
      .not.toBeInTheDocument();
  },
);

it("keeps an unsaved comment draft visible until it is cancelled", async () => {
  setup({ paged: false });
  using _settings = hideFiles("^a\\.ts$", false);
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const details: PullRequestDetailView = {
    ...detail,
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, inlineComment: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
  await using screen = await render(tab(0, null, details), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Expand all files" }).click();
  const line = screen.getByText("1", { exact: true }).last();
  await expect.element(line).toBeVisible();
  for (const type of ["pointerdown", "pointerup"]) {
    line.element().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
        pointerId: 1,
        button: 0,
      }),
    );
  }
  const draft = screen.getByRole("textbox", { name: "Comment on lines a.ts:1" });
  await draft.fill("Keep my unsaved comment");

  await screen.getByRole("button", { name: "Hide matching files" }).click();

  await expect.element(draft).toBeVisible();
  await expect.element(draft).toHaveValue("Keep my unsaved comment");
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(screen.getByText("All matching files are hidden.")).toBeVisible();
});

function pagedContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  return container;
}

// Rows are virtualized, so a header far down is not rendered until the view scrolls to it.
async function expectFileHeaderShown(
  screen: Awaited<ReturnType<typeof render>>,
  container: HTMLElement,
  path: string,
) {
  const header = screen.getByText(path, { exact: true }).first();
  await expect.element(header).toBeInTheDocument();
  await vi.waitFor(() => {
    const top = header.element().getBoundingClientRect().top;
    const bounds = container.getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(bounds.top);
    expect(top).toBeLessThan(bounds.top + bounds.height / 2);
  });
}

it("scrolls to a file asked for as the tab opens", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0, { path: "early-39.ts", nonce: 1 }), { container });

  await expectFileHeaderShown(screen, container, "early-39.ts");
});

it("pages forward to a file asked for that is not loaded yet, then scrolls to it", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();

  await screen.rerender(tab(0, { path: "late.ts", nonce: 1 }));

  await expectFileHeaderShown(screen, container, "late.ts");
});

it("never requests the diff of a selected commit the pull request no longer has", async () => {
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
            oid: "kept",
            messageHeadline: "Kept commit",
            committedDate: "2026-09-01T00:00:00Z",
          },
        ],
      }}
      selectedCommitOid="gone"
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />,
    { container },
  );

  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Diff scope: All commits" }))
    .toBeVisible();
  expect(mocks.diffCommits).not.toContain("gone");
});
