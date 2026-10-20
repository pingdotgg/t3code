import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestComment,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { PullRequestSummaryTab } from "./PullRequestSummaryTab";

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
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const render = (value = detail) =>
  act(async () =>
    root.render(
      <PullRequestSummaryTab
        scrollerRef={() => {}}
        environmentId={EnvironmentId.make("environment")}
        threadRef={null}
        reference={value}
        detail={value}
        activityPending={false}
        activityError={null}
        onRefresh={() => {}}
      />,
    ),
  );

function heading(title: string) {
  const section = container.querySelector(`section[aria-label="${title}"]`);
  expect(section, `section ${title}`).not.toBeNull();
  return [...section!.querySelectorAll("button")].find(
    (button) => button.querySelector("span")?.textContent === title,
  )!;
}

const click = (title: string) => act(async () => heading(title).click());
const expanded = (title: string) => heading(title).getAttribute("aria-expanded");
const visibleText = () => container.innerText;

it("toggles checks from their heading and resets sections for another pull request", async () => {
  await render();
  expect(visibleText()).not.toContain("Unit tests");
  await click("Checks");
  expect(visibleText()).toContain("Unit tests");
  await click("Checks");
  expect(expanded("Checks")).toBe("false");
  await click("Checks");
  await click("Description");
  await render({ ...detail, url: "https://github.com/owner/repo/pull/2", number: 2 });
  expect(expanded("Checks")).toBe("false");
  expect(expanded("Description")).toBe("true");
});

it("keeps an unsaved description when collapsed and reopened", async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  const textarea = container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Unsaved description");
  await click("Description");
  expect(expanded("Description")).toBe("false");
  await click("Description");
  expect(container.querySelector("textarea")!.value).toBe("Unsaved description");
});

function commentTexts() {
  const section = [...container.querySelectorAll("section")].find((element) =>
    element.getAttribute("aria-label")?.startsWith("Comments"),
  )!;
  return [...section.querySelectorAll("p")]
    .filter((p) => p.checkVisibility())
    .map((p) => p.textContent ?? "");
}

const filterButton = () =>
  container.querySelector<HTMLButtonElement>('[aria-label="Filter comments"]')!;

function filterItem(label: string) {
  const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((element) =>
    element.textContent?.includes(label),
  ) as HTMLElement | undefined;
  expect(item, `filter ${label}`).toBeDefined();
  return item!;
}

async function toggleFilter(label: string) {
  if (!document.querySelector('[role="menuitemcheckbox"]')) await userEvent.click(filterButton());
  await userEvent.click(filterItem(label));
}

it("hides bot and resolved comments until the filter shows them, and remembers the choice", async () => {
  const comment = (index: number, login: string, body: string, isBot = false) => ({
    id: `comment-${index}`,
    kind: "issue-comment" as const,
    author: { login, name: null, avatarUrl: null, isBot },
    body,
    createdAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}Z`,
    url: null,
    path: null,
    reviewState: null,
  });
  const resolved = {
    ...comment(13, "reviewer", "Resolved remark"),
    kind: "review-comment" as const,
  };
  const value: PullRequestDetailView = {
    ...detail,
    commentCount: 14,
    comments: [
      ...Array.from({ length: 12 }, (_, index) =>
        comment(index, "review-app", `Bot report ${index}`, true),
      ),
      comment(12, "human", "Human comment"),
      resolved,
    ],
    reviewThreads: [
      {
        id: "thread",
        path: "src/index.ts",
        line: 1,
        side: "right",
        isResolved: true,
        isOutdated: false,
        comments: [resolved],
      },
    ],
  };
  await render(value);
  expect(commentTexts()).toEqual(["Human comment"]);
  expect(filterButton().textContent).toContain("13 hidden");

  await toggleFilter("Bot comments");
  expect(commentTexts().filter((text) => text.startsWith("Bot report"))).toHaveLength(9);
  expect(commentTexts()).toContain("Human comment");
  expect(commentTexts()).not.toContain("Bot report 0");

  await toggleFilter("Resolved or dismissed");
  await userEvent.keyboard("{Escape}");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Resolved"),
  ).toBe(true);

  await act(async () => root.unmount());
  root = createRoot(container);
  await render({ ...value, url: `${value.url}0`, number: 10 });
  expect(commentTexts()).toContain("Bot report 11");
  await userEvent.click(filterButton());
  expect(filterItem("Bot comments").getAttribute("aria-checked")).toBe("true");
});

it("reveals whole older conversations with honest partial reply counts and a host link", async () => {
  const comment = (index: number): PullRequestComment => ({
    id: `comment-${index}`,
    kind: "issue-comment",
    author: detail.author,
    body: `Comment ${index}`,
    createdAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}Z`,
    url: `${detail.url}#comment-${index}`,
    path: null,
    reviewState: null,
  });
  const finding = { ...comment(0), kind: "review-comment" as const, body: "Review finding" };
  const reply = { ...comment(12), kind: "review-comment" as const, body: "Loaded reply" };
  const thread = {
    id: "partial-thread",
    path: "src/index.ts",
    line: 1,
    side: "right" as const,
    isResolved: true,
    isOutdated: false,
    comments: [finding, reply],
    nextCommentsCursor: "next-page",
  };
  const value: PullRequestDetailView = {
    ...detail,
    comments: [finding, ...Array.from({ length: 10 }, (_, index) => comment(index + 1)), reply],
    commentCount: 15,
    reviewThreads: [{ ...thread, commentCount: 5 }],
  };
  await render(value);
  await toggleFilter("Resolved or dismissed");
  await userEvent.keyboard("{Escape}");
  const older = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Show 1 older"),
  )!;
  expect(older).toBeDefined();
  expect.soft(older.textContent).toMatch(/1 older conversation.*1 hidden/);
  expect(commentTexts()).not.toContain(reply.body);
  await userEvent.click(older);
  const resolved = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Resolved",
  )!;
  expect(resolved.getAttribute("aria-expanded")).toBe("false");
  expect(commentTexts()).not.toContain(reply.body);
  expect.soft(visibleText()).toContain("4 replies");
  await userEvent.click(resolved);
  expect(commentTexts().slice(-2)).toEqual([finding.body, reply.body]);
  expect.soft(visibleText()).toContain("3 more replies");
  const hostLink = [...container.querySelectorAll("a")].find(
    (link) =>
      link.href === finding.url && /host/i.test(link.textContent ?? "") && link.checkVisibility(),
  );
  expect.soft(hostLink, "visible link to the unloaded replies on the host").toBeDefined();

  await render({ ...value, reviewThreads: [thread] });
  expect.soft(visibleText()).toMatch(/more replies/i);
  expect(visibleText()).not.toContain("3 more replies");
});
