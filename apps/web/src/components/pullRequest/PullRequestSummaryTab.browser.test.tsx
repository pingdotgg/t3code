import {
  DEFAULT_CLIENT_SETTINGS,
  SourceControlProviderKind,
  type ClientSettings,
} from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  canUpdate: true,
  timestampFormat: "locale" as "locale" | "12-hour" | "24-hour",
  openLink: vi.fn(async () => {}),
}));

vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink: () => state.openLink }));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.update) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select?: (settings: ClientSettings) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: state.timestampFormat };
    return select ? select(settings) : settings;
  }) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      update: {
        ...actual.pullRequestEnvironment.update,
        permissionAtom: () => (state.canUpdate ? allowed : denied),
      },
    },
  };
});

function setup() {
  state.update.mockReset();
  state.update.mockResolvedValue({ _tag: "Success", value: undefined });
  state.canUpdate = true;
  state.timestampFormat = "locale";
  state.openLink.mockClear();
}

import "~/index.css";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { act, fakeTimers, render as renderUi } from "../../../test/render";
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

// The comment filter persists to localStorage, so tests that touch it start and end empty.

const tab = (value = detail) => (
  <PullRequestSummaryTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    threadRef={null}
    reference={value}
    detail={value}
    observedAt={value.observedAt}
    activityPending={false}
    activityError={null}
    onRefresh={() => {}}
  />
);

async function render(value = detail) {
  const screen = await renderUi(tab(value));
  const { container } = screen;
  const heading = (title: string) => {
    const section = container.querySelector(`section[aria-label="${title}"]`);
    expect(section, `section ${title}`).not.toBeNull();
    return [...section!.querySelectorAll("button")].find(
      (button) => button.querySelector("span")?.textContent === title,
    )!;
  };
  return Object.assign(screen, {
    click: (title: string) => act(async () => heading(title).click()),
    expanded: (title: string) => heading(title).getAttribute("aria-expanded"),
    visibleText: () => container.innerText,
  });
}

it("updates comment ages without another panel render", async () => {
  using _timers = fakeTimers({ now: new Date("2026-09-01T00:05:00Z") });
  await using screen = await render({
    ...detail,
    commentCount: 1,
    comments: [
      {
        id: "comment",
        kind: "issue-comment",
        author: detail.author,
        body: "Review comment",
        createdAt: detail.createdAt,
        url: null,
        path: null,
        reviewState: null,
      },
    ],
  });
  const time = screen.container.querySelector("time")!;
  expect(time.textContent).toBe("5m ago");
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(time.textContent).toBe("6m ago");
});

it("grows a collapsed description into the room a sparse summary leaves", async () => {
  const sparse = {
    ...detail,
    body: Array.from({ length: 40 }, (_, index) => `Description paragraph ${index + 1}.`).join(
      "\n\n",
    ),
  };
  const sized = (value: PullRequestDetailView) => <div style={{ height: 600 }}>{tab(value)}</div>;
  await using screen = await renderUi(sized(sparse));
  const clip = () =>
    screen.container.querySelector<HTMLElement>("[data-pr-description] [data-comment-clip]")!;
  const scroller = screen.container.querySelector<HTMLElement>(
    "[data-pull-request-summary-scroll]",
  )!;
  await expect
    .element(screen.getByRole("button", { name: "Read more", exact: true }))
    .toBeVisible();
  await vi.waitFor(() => expect(clip().getBoundingClientRect().height).toBeGreaterThan(300));
  expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight);
  await userEvent.click(screen.getByRole("button", { name: "Read more", exact: true }));
  await expect
    .element(screen.getByText("Description paragraph 40.", { exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show less", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Read more", exact: true }))
    .toBeVisible();
  await screen.rerender(
    sized({
      ...sparse,
      commentCount: 12,
      comments: Array.from({ length: 12 }, (_, index) => ({
        id: `comment-${index}`,
        kind: "issue-comment",
        author: detail.author,
        body: `Conversation entry ${index + 1}`,
        createdAt: detail.createdAt,
        url: null,
        path: null,
        reviewState: null,
      })),
    }),
  );
  await vi.waitFor(() => expect(clip().getBoundingClientRect().height).toBe(64));
  await expect
    .element(screen.getByRole("button", { name: "Read more", exact: true }))
    .toBeVisible();
});

it("keeps an unsaved description when collapsed and reopened, and after a failed save", async () => {
  setup();
  state.update.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });
  await using screen = await render();
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Unsaved description");
  await screen.click("Description");
  expect(screen.expanded("Description")).toBe("false");
  await screen.click("Description");
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(state.update).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");
});

it("ticks a description checkbox placed after an attachment and edits from the ticked body", async () => {
  setup();
  let finishSave = (_result: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
  const body = "Intro\n\nhttps://example.com/shot.png\n\n## Test plan\n- [ ] First\n- [ ] Second";
  const ticked = body.replace("- [ ] Second", "- [x] Second");
  await using screen = await renderUi(
    <div style={{ height: 1000 }}>{tab({ ...detail, body, observedAt: 1 })}</div>,
  );
  const boxes = () => screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes()].map((box) => box.disabled)).toEqual([false, false]);
  // A collapsed description clips the list that follows the attachment.
  const readMore = screen.getByRole("button", { name: "Read more" });
  if (readMore.query()) await userEvent.click(readMore);

  await userEvent.click(boxes()[1]!);
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "environment",
    input: expect.objectContaining({ number: 1, body: ticked }),
  });
  expect([...boxes()].map((box) => box.checked)).toEqual([false, true]);
  await act(async () => finishSave({ _tag: "Success", value: undefined }));

  // The host has not been read since the save, so the editor starts from the ticked body.
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  expect(screen.container.querySelector("textarea")!.value).toBe(ticked);
});

it("leaves description checkboxes read-only without the right to edit it", async () => {
  setup();
  const body = "- [ ] First";
  {
    await using screen = await render({ ...detail, body, viewer: "someone-else" });
    expect(
      screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
    ).toBe(true);
  }
  state.canUpdate = false;
  await using screen = await render({ ...detail, body });
  expect(screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(
    true,
  );
});

it("fixes an overview thread as its opening remark, since it has no line to attach", async () => {
  setup();
  const author = { login: "reviewer", name: null, avatarUrl: null };
  const note = { author, createdAt: "2026-09-01T00:00:00Z", url: null };
  const remark = {
    ...note,
    id: "10",
    kind: "review-comment" as const,
    body: "Mention the flag in the README",
    path: null,
    reviewState: null,
  };
  const onFixFinding = vi.fn();
  const value: PullRequestDetailView = {
    ...detail,
    comments: [remark],
    overviewThreads: [
      {
        id: "overview",
        path: null,
        line: null,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [{ ...note, id: "10", body: remark.body }],
      },
    ],
  };
  await using screen = await renderUi(
    <PullRequestSummaryTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={value}
      detail={value}
      observedAt={value.observedAt}
      activityPending={false}
      activityError={null}
      onRefresh={() => {}}
      onFixFinding={onFixFinding}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Fix in a thread" }));
  expect(onFixFinding).toHaveBeenCalledWith({ kind: "comment", comment: remark });
});

it("shows a comment's exact time in the chosen 24-hour clock", async () => {
  setup();
  state.timestampFormat = "24-hour";
  const createdAt = "2026-09-01T17:30:00Z";
  const comment = {
    id: "10",
    kind: "review-comment" as const,
    body: "A remark",
    author: { login: "reviewer", name: null, avatarUrl: null },
    createdAt,
    url: null,
    path: null,
    reviewState: null,
  };
  await using screen = await render({ ...detail, comments: [comment], commentCount: 1 });

  await userEvent.hover(screen.container.querySelector(`time[datetime="${createdAt}"]`)!);
  const expected = new Date(createdAt).toLocaleString(undefined, { hour12: false });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(expected),
  );
});

function openThread(id: string, bot = false): PullRequestReviewThread {
  return {
    id,
    path: `src/${id}.ts`,
    line: 1,
    side: "right",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: `${id}-comment`,
        author: { ...detail.author!, isBot: bot },
        body: `Finding ${id}`,
        createdAt: detail.createdAt,
        url: null,
      },
    ],
  };
}

it.each(["review", "issue-comment", "resolved-reply"] as const)(
  "reveals a linked %s in the summary conversation",
  async (kind) => {
    setup();
    const url = `${detail.url}#${kind === "review" ? "pullrequestreview-123" : kind === "issue-comment" ? "issuecomment-123" : "discussion_r123"}`;
    const linkedDetail: PullRequestDetailView = {
      ...detail,
      comments:
        kind === "resolved-reply"
          ? []
          : [
              {
                id: "linked",
                kind,
                author: detail.author,
                body: "Linked reply",
                createdAt: "2026-10-01T00:00:00Z",
                url,
                path: null,
                reviewState: kind === "review" ? "CHANGES_REQUESTED" : null,
              },
            ],
      reviewThreads:
        kind !== "resolved-reply"
          ? []
          : [
              {
                id: "thread",
                path: "src/test.ts",
                line: 5,
                side: "right",
                isResolved: true,
                isOutdated: false,
                comments: [
                  {
                    id: "root",
                    author: detail.author,
                    body: "Root comment",
                    createdAt: "2026-10-01T00:00:00Z",
                    url: `${detail.url}#discussion_r122`,
                  },
                  {
                    id: "reply",
                    author: detail.author,
                    body: "Linked reply",
                    createdAt: "2026-10-01T00:01:00Z",
                    url,
                  },
                ],
              },
            ],
    };
    const settled = vi.fn();
    await using screen = await renderUi(
      <div style={{ height: 600 }}>
        <PullRequestSummaryTab
          scrollerRef={() => {}}
          detail={linkedDetail}
          observedAt={linkedDetail.observedAt}
          environmentId={EnvironmentId.make("environment")}
          reference={detail}
          threadRef={null}
          activityPending={false}
          activityError={null}
          onRefresh={() => {}}
          revealUrl={url}
          onRevealSettled={settled}
        />
      </div>,
    );
    await expect.element(screen.getByText("Linked reply", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
    await screen.rerender(
      <div style={{ height: 600 }}>
        <PullRequestSummaryTab
          scrollerRef={() => {}}
          detail={linkedDetail}
          observedAt={linkedDetail.observedAt}
          environmentId={EnvironmentId.make("environment")}
          reference={detail}
          threadRef={null}
          activityPending={false}
          activityError={null}
          onRefresh={() => {}}
          onRevealSettled={settled}
        />
      </div>,
    );
    await expect.element(screen.getByText("Linked reply", { exact: true })).toBeVisible();
  },
);

it("adds promoted review conversations to chat without requiring review permissions", async () => {
  setup();
  localStorage.removeItem("t3code:pull-request-comment-filter:v1");
  const thread = openThread("finding");
  const onAddToChat = vi.fn();
  const value = { ...detail, reviewThreads: [thread] };
  await using screen = await renderUi(
    <PullRequestSummaryTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={value}
      detail={value}
      observedAt={value.observedAt}
      activityPending={false}
      activityError={null}
      onRefresh={() => {}}
      onAddToChat={onAddToChat}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add to chat", exact: true }));
  expect(onAddToChat).toHaveBeenCalledWith({ kind: "thread", thread });
});

it("keeps the chosen comment order when the right panel remounts the tab", async () => {
  setup();
  const comment = (id: string, createdAt: string) => ({
    id,
    kind: "review-comment" as const,
    body: `Remark ${id}`,
    author: { login: "reviewer", name: null, avatarUrl: null },
    createdAt,
    url: null,
    path: null,
    reviewState: null,
  });
  const value = {
    ...detail,
    comments: [comment("10", "2026-09-01T10:00:00Z"), comment("11", "2026-09-02T10:00:00Z")],
    commentCount: 2,
  };
  {
    await using screen = await render(value);
    await userEvent.click(screen.getByRole("button", { name: "Show oldest comments first" }));
    await expect
      .element(screen.getByRole("button", { name: "Show newest comments first" }))
      .toBeVisible();
  }
  // Switching to another right-panel tab unmounts the pull request surface.
  await using screen = await render(value);
  await expect
    .element(screen.getByRole("button", { name: "Show newest comments first" }))
    .toBeVisible();
});

it("comes back at the scroll position it left when the right panel remounts the tab", async () => {
  setup();
  const body = Array.from({ length: 6 }, (_, index) => `Paragraph ${index}`).join("\n\n");
  const comments = Array.from({ length: 10 }, (_, index) => ({
    id: `comment-${index}`,
    kind: "issue-comment" as const,
    body,
    author: detail.author,
    createdAt: `2026-09-01T00:${String(index).padStart(2, "0")}:00Z`,
    url: null,
    path: null,
    reviewState: null,
  }));
  const value = {
    ...detail,
    comments,
    commentCount: comments.length,
    url: "https://github.com/owner/repo/pull/2",
  };
  const mount = async (shown = value) => {
    const container = document.createElement("div");
    container.className = "flex h-[300px]";
    const screen = await renderUi(tab(shown), { container });
    const scroller = container.querySelector<HTMLElement>("[data-pull-request-summary-scroll]")!;
    return Object.assign(screen, { scroller });
  };
  {
    await using screen = await mount();
    screen.scroller.scrollTop = 500;
    await vi.waitFor(() => expect(screen.scroller.scrollTop).toBe(500));
    await act(async () => screen.scroller.dispatchEvent(new Event("scroll")));
  }
  // The tab can come back before the content that reached that position has loaded.
  await using screen = await mount({ ...value, comments: [], commentCount: 0 });
  await screen.rerender(tab(value));
  await vi.waitFor(() => expect(screen.scroller.scrollTop).toBe(500));
  await screen.unmount();
  await using again = await mount();
  expect(again.scroller.scrollTop).toBe(500);
});

it("scrolls from the keyboard after a click inside it", async () => {
  setup();
  const body = Array.from({ length: 80 }, (_, index) => `Paragraph ${index}`).join("\n\n");
  const container = document.createElement("div");
  container.className = "flex h-[300px]";
  await using screen = await renderUi(
    // The panel area takes focus itself, so a click on plain text lands on it unless the tab can.
    <div {...workspaceAreaProps("panel", 4, "Workspace panel")} className="flex min-w-0 flex-1">
      {tab({ ...detail, body })}
    </div>,
    { container },
  );
  const scroller = container.querySelector<HTMLElement>("[data-pull-request-summary-scroll]")!;
  // The description starts collapsed; read all of it so the summary has something to scroll.
  await userEvent.click(screen.getByRole("button", { name: "Read more" }));
  await userEvent.click(screen.getByText("Paragraph 0", { exact: true }));
  await userEvent.keyboard("{PageDown}");
  await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
});

it("opens comment timestamps through the link-target setting, not a popup", async () => {
  setup();
  const author = { login: "reviewer", name: null, avatarUrl: null };
  const comment = (id: string, reviewState: string | null) => ({
    id,
    kind: "review" as const,
    body: `Remark ${id}`,
    author,
    createdAt: `2026-09-0${id}T00:00:00Z`,
    url: `${detail.url}#review-${id}`,
    path: null,
    reviewState,
  });
  // The dismissed review renders as a collapsed card; show it with the resolved filter on.
  localStorage.setItem(
    "t3code:pull-request-comment-filter:v1",
    JSON.stringify({ bots: false, resolved: true }),
  );
  try {
    await using screen = await render({
      ...detail,
      comments: [comment("1", null), comment("2", "DISMISSED")],
      commentCount: 2,
    });
    for (const id of ["1", "2"]) {
      const href = `${detail.url}#review-${id}`;
      const link = screen.container.querySelector(`a[href="${href}"]`);
      expect(link, href).not.toBeNull();
      state.openLink.mockClear();
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      link!.dispatchEvent(click);

      expect(click.defaultPrevented).toBe(true);
      expect(state.openLink).toHaveBeenCalledOnce();
      expect(state.openLink).toHaveBeenCalledWith(href, { event: expect.anything() });
    }
  } finally {
    localStorage.removeItem("t3code:pull-request-comment-filter:v1");
  }
});

it("opens a comment author's profile through the link-target setting, not a popup", async () => {
  setup();
  await using screen = await render({
    ...detail,
    comments: [
      {
        id: "1",
        kind: "issue-comment" as const,
        body: "Looks good",
        author: { login: "reviewer", name: null, avatarUrl: null },
        createdAt: "2026-09-01T00:00:00Z",
        url: null,
        path: null,
        reviewState: null,
      },
    ],
    commentCount: 1,
  });
  const link = await vi.waitFor(() => {
    const found = screen.container.querySelector('a[aria-label="Open reviewer\'s profile"]');
    expect(found).not.toBeNull();
    return found!;
  });
  const href = link.getAttribute("href")!;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(true);
  expect(state.openLink).toHaveBeenCalledOnce();
  expect(state.openLink).toHaveBeenCalledWith(href, { event: expect.anything() });
});

it("opens a thread's remaining replies through the link-target setting, not a popup", async () => {
  setup();
  await using screen = await render({
    ...detail,
    reviewThreads: [
      {
        id: "thread",
        path: "a.ts",
        line: 3,
        side: "right",
        isResolved: false,
        isOutdated: false,
        commentCount: 3,
        comments: [
          {
            id: "comment",
            body: "Please rename this",
            author: { login: "reviewer", name: null, avatarUrl: null },
            createdAt: "2026-09-01T00:00:00Z",
            url: "https://github.com/owner/repo/pull/1#discussion_r1",
          },
        ],
      },
    ],
  });
  const link = await vi.waitFor(() => {
    const found = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "View on host",
    );
    expect(found).toBeDefined();
    return found!;
  });
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(true);
  expect(state.openLink).toHaveBeenCalledOnce();
  expect(state.openLink).toHaveBeenCalledWith(
    "https://github.com/owner/repo/pull/1#discussion_r1",
    {
      event: expect.anything(),
    },
  );
});
