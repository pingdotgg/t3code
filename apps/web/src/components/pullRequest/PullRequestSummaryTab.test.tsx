import { SourceControlProviderKind } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("./PullRequestCommentActions", () => ({ PullRequestCommentActions: () => null }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./PullRequestMarkdown", async () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
  PullRequestMarkdownContext: (await import("react")).createContext(null),
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuCheckboxItem: "div",
  MenuRadioGroup: "div",
  MenuRadioItem: "div",
  MenuGroup: "div",
  MenuGroupLabel: "div",
  MenuPopup: "div",
  MenuTrigger: "div",
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
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

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = new Map<string, string>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    }),
  );
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function render(value = detail) {
  return (
    <PullRequestSummaryTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={value}
      detail={value}
      activityPending={false}
      activityError={null}
      onRefresh={() => {}}
    />
  );
}

function renderedText() {
  return renderer.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
}

it("shows a current Azure approval without review comments and removes it after reset", () => {
  const azure = {
    ...detail,
    provider: SourceControlProviderKind.make("azure-devops"),
    reviewers: [
      { login: "reviewer", name: "Reviewer", avatarUrl: null, reviewState: "approved" as const },
    ],
  };
  act(() => {
    renderer = create(render(azure));
  });
  expect(renderedText()).toContain("Approved");
  act(() => {
    renderer.update(
      render({ ...azure, reviewers: [{ ...azure.reviewers[0]!, reviewState: "none" }] }),
    );
  });
  expect(renderedText()).not.toContain("Approved");
});

it("switches Azure discussion filters without losing the parent of a matching reply", () => {
  const base = {
    kind: "issue-comment" as const,
    path: null,
    url: null,
    reviewState: null,
    createdAt: "2026-09-01T00:00:00Z",
  };
  const azure: PullRequestDetailView = {
    ...detail,
    provider: SourceControlProviderKind.make("azure-devops"),
    commentCount: 3,
    comments: [
      {
        ...base,
        id: "root",
        threadId: "a",
        threadStatus: "active",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "Original question",
      },
      {
        ...base,
        id: "reply",
        threadId: "a",
        replyToCommentId: "root",
        threadStatus: "active",
        author: detail.author,
        body: "My answer",
      },
      {
        ...base,
        id: "resolved",
        threadId: "r",
        threadStatus: "fixed",
        author: detail.author,
        body: "Finished question",
      },
    ],
    events: [
      { id: "event", actor: detail.author, createdAt: base.createdAt, body: "Pushed an update" },
    ],
  };
  act(() => {
    renderer = create(render(azure));
  });
  const select = (value: string) =>
    act(() =>
      renderer.root
        .findAllByType("div")
        .find((node) => typeof node.props.onValueChange === "function")!
        .props.onValueChange(value),
    );
  expect(renderedText()).toContain("Pushed an update");
  select("comments");
  expect(renderedText()).not.toContain("Pushed an update");
  select("active");
  expect(renderedText()).toContain("Original question");
  expect(renderedText()).toContain("My answer");
  expect(renderedText()).not.toContain("Finished question");
  select("resolved");
  expect(renderedText()).toContain("Finished question");
  expect(renderedText()).not.toContain("Original question");
  select("mine");
  expect(renderedText()).toContain("Original question");
  expect(renderedText()).toContain("My answer");
});

function heading(title: string) {
  const section = renderer.root
    .findAllByType("section")
    .find((section) => section.props["aria-label"] === title)!;
  return section
    .findAllByType("button")
    .find((button) => button.findAllByType("span").some((span) => span.children.includes(title)))!;
}

function click(title: string) {
  act(() =>
    heading(title).props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }),
  );
}

it("toggles checks from their heading and resets sections for another pull request", () => {
  act(() => {
    renderer = create(render());
  });
  expect(
    renderer.root.findAllByType("span").some((span) => span.children.includes("Unit tests")),
  ).toBe(false);
  click("Checks");
  expect(
    renderer.root.findAllByType("span").some((span) => span.children.includes("Unit tests")),
  ).toBe(true);
  click("Checks");
  expect(heading("Checks").props["aria-expanded"]).toBe(false);
  click("Checks");
  click("Description");
  act(() =>
    renderer.update(render({ ...detail, url: "https://github.com/owner/repo/pull/2", number: 2 })),
  );
  expect(heading("Checks").props["aria-expanded"]).toBe(false);
  expect(heading("Description").props["aria-expanded"]).toBe(true);
});

it("keeps an unsaved description when collapsed and reopened", () => {
  act(() => {
    renderer = create(render());
  });
  act(() => renderer.root.findByProps({ "aria-label": "Edit description" }).props.onClick());
  act(() =>
    renderer.root.findByType("textarea").props.onChange({
      target: { value: "Unsaved description" },
      currentTarget: { value: "Unsaved description" },
      nativeEvent: {},
    }),
  );
  click("Description");
  expect(heading("Description").props["aria-expanded"]).toBe(false);
  click("Description");
  expect(renderer.root.findByType("textarea").props.value).toBe("Unsaved description");
});

function texts() {
  return renderer.root
    .findAllByType("p")
    .map((p) => p.children.join(""))
    .filter((text) => text !== detail.body);
}

function filterItem(label: string) {
  return renderer.root.find(
    (node) => typeof node.props.onCheckedChange === "function" && node.children.includes(label),
  );
}

it("keeps an Azure discussion in one card with the original before its replies", () => {
  const original = {
    id: "17:1",
    kind: "issue-comment" as const,
    author: { login: "reviewer", name: "Reviewer", avatarUrl: null },
    body: "Could you cover the empty state?",
    createdAt: "2026-09-01T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
  const value: PullRequestDetailView = {
    ...detail,
    provider: SourceControlProviderKind.make("azure-devops"),
    comments: [
      original,
      {
        ...original,
        id: "17:2",
        replyToCommentId: "17:1",
        author: detail.author,
        body: "Added coverage.",
        createdAt: "2026-09-01T00:01:00Z",
      },
    ],
    commentCount: 2,
  };
  act(() => {
    renderer = create(render(value));
  });
  expect(renderer.root.findAllByType("article")).toHaveLength(1);
  expect(texts()).not.toContain("Reply to Reviewer");
  expect(texts()).toContain("Could you cover the empty state?");
  expect(texts()).toContain("Added coverage.");
  expect(texts().indexOf("Could you cover the empty state?")).toBeLessThan(
    texts().indexOf("Added coverage."),
  );

  act(() =>
    renderer.root.findByProps({ "aria-label": "Show oldest comments first" }).props.onClick(),
  );
  expect(renderer.root.findAllByType("article")).toHaveLength(1);
  expect(texts().indexOf("Could you cover the empty state?")).toBeLessThan(
    texts().indexOf("Added coverage."),
  );

  act(() =>
    renderer.update(
      render({ ...value, comments: value.comments.slice(1), commentsTruncated: true }),
    ),
  );
  expect(texts()).toContain("Reply to earlier comment");
  expect(texts()).toContain("Original comment isn’t loaded.");
});

it("hides bot and resolved comments until the filter shows them, and remembers the choice", () => {
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
  act(() => {
    renderer = create(render(value));
  });
  expect(texts()).toEqual(["Human comment"]);
  expect(
    renderer.root.findByProps({ "aria-label": "Filter comments" }).children.join(""),
  ).toContain("13 hidden");

  act(() => filterItem("Bot comments").props.onCheckedChange(true));
  expect(texts().filter((text) => text.startsWith("Bot report"))).toHaveLength(9);
  expect(texts()).toContain("Human comment");
  expect(texts()).not.toContain("Bot report 0");

  act(() => filterItem("Resolved or dismissed").props.onCheckedChange(true));
  expect(
    renderer.root.findAllByType("button").some((button) => button.children.includes("Resolved")),
  ).toBe(true);

  act(() => renderer.unmount());
  act(() => {
    renderer = create(render({ ...value, url: `${value.url}0`, number: 10 }));
  });
  expect(filterItem("Bot comments").props.checked).toBe(true);
  expect(texts()).toContain("Bot report 11");
});
