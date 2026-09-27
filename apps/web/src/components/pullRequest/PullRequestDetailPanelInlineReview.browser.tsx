import "../../index.css";

import type {
  EnvironmentApi,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestSubmitReviewInput,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { __resetLocalApiForTests } from "../../localApi";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import {
  PULL_REQUEST_INLINE_REVIEW_ACTIVITY,
  PULL_REQUEST_INLINE_REVIEW_DETAIL,
  PULL_REQUEST_INLINE_REVIEW_DIFF,
  PULL_REQUEST_INLINE_REVIEW_ENVIRONMENT_ID,
  PULL_REQUEST_INLINE_REVIEW_REFERENCE,
} from "./pullRequestInlineReviewFixture";
import { pullRequestQueryKeys } from "~/lib/pullRequestReactQuery";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const environmentId = PULL_REQUEST_INLINE_REVIEW_ENVIRONMENT_ID;
const reference = PULL_REQUEST_INLINE_REVIEW_REFERENCE;
const reviewKey = pullRequestReviewKey(reference);
const expectedReviewInput = {
  ...reference,
  verdict: "comment",
  body: "",
  comments: [
    {
      path: "src/engine.ts",
      line: 3,
      side: "right",
      body: "Check the new value.",
    },
    {
      path: "src/engine.ts",
      line: 3,
      side: "left",
      body: "This old value was unstable.",
    },
    {
      path: "src/engine.ts",
      line: 4,
      side: "right",
      body: "Keep this invariant.",
    },
  ],
} satisfies PullRequestSubmitReviewInput;

let queryClient: QueryClient | undefined;

afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  queryClient?.clear();
  queryClient = undefined;
  usePullRequestReviewStore.getState().clear(reviewKey);
  usePullRequestReviewStore.getState().clearSubmitted(reviewKey, "");
  __resetEnvironmentApiOverridesForTests();
  await __resetLocalApiForTests();
  Reflect.deleteProperty(window, "nativeApi");
});

function createMonitorStatus(): Awaited<
  ReturnType<EnvironmentApi["pullRequestMonitors"]["status"]>
> {
  return {
    monitor: null,
    ownerCandidates: [],
    latestSnapshot: null,
    recentEvents: [],
    openFeedback: [],
    recentDeliveries: [],
    recentReports: [],
  };
}

async function renderPanel(
  submitReview: EnvironmentApi["pullRequests"]["submitReview"],
  detail: PullRequestDetail = PULL_REQUEST_INLINE_REVIEW_DETAIL,
  activity: PullRequestActivity = PULL_REQUEST_INLINE_REVIEW_ACTIVITY,
): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  queryClient = client;
  Reflect.set(window, "nativeApi", {
    persistence: { getClientSettings: async () => null },
  });
  const api: EnvironmentApi = {
    terminal: {} as EnvironmentApi["terminal"],
    projects: {} as EnvironmentApi["projects"],
    filesystem: {} as EnvironmentApi["filesystem"],
    assets: {} as EnvironmentApi["assets"],
    preview: {} as EnvironmentApi["preview"],
    git: {} as EnvironmentApi["git"],
    pullRequests: Object.assign({} as EnvironmentApi["pullRequests"], {
      detail: async () => detail,
      activity: async () => activity,
      submitReview,
    }),
    pullRequestMonitors: Object.assign({} as EnvironmentApi["pullRequestMonitors"], {
      status: async () => createMonitorStatus(),
    }),
    collaborativeAcceptance: {} as EnvironmentApi["collaborativeAcceptance"],
    workflow: {} as EnvironmentApi["workflow"],
    server: {} as EnvironmentApi["server"],
    orchestration: {} as EnvironmentApi["orchestration"],
  };
  __setEnvironmentApiOverrideForTests(environmentId, api);

  client.setQueryData(pullRequestQueryKeys.detail(environmentId, reference), detail);
  client.setQueryData(pullRequestQueryKeys.activity(environmentId, reference), activity);
  client.setQueryData(
    pullRequestQueryKeys.monitorStatus(environmentId, reference),
    createMonitorStatus(),
  );
  client.setQueryData(pullRequestQueryKeys.diffInfinite(environmentId, reference), {
    pages: [PULL_REQUEST_INLINE_REVIEW_DIFF],
    pageParams: [null],
  });
  for (const commit of activity.commits) {
    client.setQueryData(
      pullRequestQueryKeys.diffInfinite(environmentId, { ...reference, commit: commit.oid }),
      {
        pages: [
          {
            ...PULL_REQUEST_INLINE_REVIEW_DIFF,
            patch: PULL_REQUEST_INLINE_REVIEW_DIFF.patch.replace(
              "const current = before + 1;",
              "const historical = before + 2;",
            ),
          },
        ],
        pageParams: [null],
      },
    );
  }

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <div style={{ height: 900 }}>
          <PullRequestDetailPanel
            environmentId={environmentId}
            reference={reference}
            onClose={() => undefined}
          />
        </div>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await render(<RouterProvider router={router} />);
}

function selectDiffLine(line: number, lineType: string): void {
  const diffFile = [...document.querySelectorAll("diffs-container")].find((file) =>
    [...(file.shadowRoot?.querySelectorAll<HTMLElement>("[data-line][data-line-type]") ?? [])].some(
      (element) => element.dataset.line === String(line) && element.dataset.lineType === lineType,
    ),
  );
  const lineElement = [
    ...(diffFile?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line][data-line-type]") ?? []),
  ].find(
    (element) => element.dataset.line === String(line) && element.dataset.lineType === lineType,
  );
  if (!lineElement) throw new Error(`Diff line ${line} (${lineType}) was not rendered.`);

  const range = document.createRange();
  range.selectNodeContents(lineElement);
  const selection = window.getSelection();
  if (!selection) throw new Error("The browser does not expose a document selection.");
  selection.removeAllRanges();
  selection.addRange(range);
  lineElement.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true }));
}

async function addLineComment(
  line: number,
  lineType: string,
  body: string,
  expectedSide: "left" | "right",
): Promise<void> {
  selectDiffLine(line, lineType);
  const dialog = page.getByRole("dialog", {
    name: `Comment on src/engine.ts:${line}`,
  });
  await expect.element(dialog).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add comment" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Review comment" }).fill(body);
  await expect.element(page.getByRole("button", { name: "Add comment" })).toBeEnabled();
  await page.getByRole("button", { name: "Add comment" }).click();
  expect(document.querySelector("[data-pull-request-inline-comment]")).toBeNull();
  expect(
    usePullRequestReviewStore
      .getState()
      .commentsByKey[reviewKey]?.some(
        (comment) =>
          comment.line === line && comment.side === expectedSide && comment.body === body,
      ),
  ).toBe(true);
}

async function openCodeTab(): Promise<void> {
  expect(document.querySelector('[aria-label="Pull request collaboration status"]')).toBeNull();
  await page.getByRole("tab", { name: /code/i }).click();
  await expect.element(page.getByText("src/engine.ts")).toBeVisible();
  expect(document.querySelector('[aria-label="Pull request collaboration status"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Add a line comment");
}

describe("PullRequestDetailPanel inline review comments", () => {
  it("keeps checks visible across tabs and groups comments without hiding lifecycle or collaboration", async () => {
    const detail: PullRequestDetail = {
      ...PULL_REQUEST_INLINE_REVIEW_DETAIL,
      state: "closed",
      closedAt: "2026-08-12T12:00:00.000Z",
      checks: [{ name: "Typecheck", status: "success", description: null, url: null }],
    };
    const activity: PullRequestActivity = {
      ...PULL_REQUEST_INLINE_REVIEW_ACTIVITY,
      commentCount: 2,
      comments: ["First observation", "Second observation"].map((body, index) => ({
        id: `comment-${index}`,
        kind: "issue-comment",
        author: detail.author,
        body,
        createdAt: `2026-08-11T1${index}:00:00.000Z`,
        url: null,
        path: null,
        reviewState: null,
      })),
    };
    await renderPanel(vi.fn(), detail, activity);
    await expect.element(page.getByText("Typecheck", { exact: true })).toBeVisible();
    await expect.element(page.getByText("1 of 1 passing")).toBeVisible();
    await page.getByRole("button", { name: "Collapse comment by octocat" }).first().click();
    await expect.element(page.getByText("Second observation")).not.toBeInTheDocument();

    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect.element(page.getByText("Pull request closed", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Pull request opened", { exact: true })).toBeVisible();
    await expect.element(page.getByText("First observation")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "2 comments" }).click();
    await expect.element(page.getByText("First observation")).toBeVisible();
    await expect.element(page.getByText("Second observation")).toBeVisible();
    await expect.element(page.getByText("1 of 1 passing")).toBeVisible();

    await page.getByRole("tab", { name: "Agent Collaboration" }).click();
    await expect
      .element(page.getByRole("group", { name: "Pull request collaboration status" }))
      .toBeVisible();
  });

  it("opens a commit from Timeline and prevents historical line comments until returning to all commits", async () => {
    const commit = {
      oid: "0123456789abcdef0123456789abcdef01234567",
      messageHeadline: "Stabilize engine updates",
      committedDate: "2026-08-11T12:00:00.000Z",
      additions: 1,
      deletions: 1,
      authors: [{ login: "octocat", name: "Octo Cat", avatarUrl: null }],
    };
    await renderPanel(vi.fn(), PULL_REQUEST_INLINE_REVIEW_DETAIL, {
      ...PULL_REQUEST_INLINE_REVIEW_ACTIVITY,
      commits: [commit],
    });
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await page.getByRole("button", { name: `View commit ${commit.oid.slice(0, 7)}` }).click();
    await expect
      .element(page.getByRole("tab", { name: "Code", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByText("src/engine.ts", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        [...document.querySelectorAll("diffs-container")].some((element) =>
          element.shadowRoot?.textContent?.includes("const historical = before + 2;"),
        ),
      )
      .toBe(true);
    selectDiffLine(3, "change-addition");
    expect(document.querySelector("[data-pull-request-inline-comment]")).toBeNull();
    await page.getByRole("button", { name: "Return to all commits" }).click();
    await expect.element(page.getByText("src/engine.ts", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        [...document.querySelectorAll("diffs-container")].some((element) =>
          element.shadowRoot?.textContent?.includes("const current = before + 1;"),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Collapse src/engine.ts" }).click();
    await expect.element(page.getByRole("button", { name: "Expand src/engine.ts" })).toBeVisible();
    await page.getByRole("button", { name: "Expand src/engine.ts" }).click();
    await addLineComment(3, "change-addition", "Review the current diff.", "right");
    await page.getByRole("button", { name: "Split diff view" }).click();
    await expect
      .element(page.getByRole("button", { name: "Split diff view" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("1 pending line comment", { exact: true })).toBeVisible();
  });

  it("opens and dismisses the selection popover without adding an unfinished comment", async () => {
    const submitReview = vi.fn<EnvironmentApi["pullRequests"]["submitReview"]>();
    await renderPanel(submitReview);
    await openCodeTab();

    selectDiffLine(3, "change-addition");
    const dialog = page.getByRole("dialog", { name: "Comment on src/engine.ts:3" });
    await expect.element(dialog).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("[data-pull-request-inline-comment]")).toBeNull();
    expect(usePullRequestReviewStore.getState().commentsByKey[reviewKey]).toBeUndefined();

    selectDiffLine(3, "change-deletion");
    const deletionDialog = page.getByRole("dialog", { name: "Comment on src/engine.ts:3" });
    await expect.element(deletionDialog).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(document.querySelector("[data-pull-request-inline-comment]")).toBeNull();
    expect(usePullRequestReviewStore.getState().commentsByKey[reviewKey]).toBeUndefined();
  });

  it("submits added, deleted, and context-line comments; keeps failures retryable without duplicates", async () => {
    let rejectFirstAttempt: ((error: Error) => void) | undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    const submitReview = vi.fn<EnvironmentApi["pullRequests"]["submitReview"]>();
    submitReview.mockReturnValueOnce(firstAttempt);
    submitReview.mockResolvedValue(undefined);
    await renderPanel(submitReview);
    await openCodeTab();

    await addLineComment(3, "change-addition", "Check the new value.", "right");
    await addLineComment(3, "change-deletion", "This old value was unstable.", "left");
    await addLineComment(4, "context", "Keep this invariant.", "right");
    await expect.element(page.getByText("3 pending line comments")).toBeVisible();

    const submitButton = page.getByRole("button", { name: "Comment", exact: true });
    await submitButton.click();
    await expect.element(submitButton).toBeDisabled();
    const disabledSubmitButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Comment" && button.disabled,
    );
    disabledSubmitButton?.click();
    expect(submitReview).toHaveBeenCalledTimes(1);
    expect(submitReview).toHaveBeenNthCalledWith(1, expectedReviewInput);

    if (!rejectFirstAttempt) throw new Error("The first review attempt was not captured.");
    rejectFirstAttempt(new Error("Fixture submission failure"));
    await expect.element(submitButton).toBeEnabled();
    await expect.element(page.getByText("3 pending line comments")).toBeVisible();

    await submitButton.click();
    expect(submitReview).toHaveBeenCalledTimes(2);
    expect(submitReview).toHaveBeenNthCalledWith(2, expectedReviewInput);
    await expect.element(page.getByText("3 pending line comments")).not.toBeInTheDocument();
    expect(usePullRequestReviewStore.getState().commentsByKey[reviewKey]).toBeUndefined();
  });
});
