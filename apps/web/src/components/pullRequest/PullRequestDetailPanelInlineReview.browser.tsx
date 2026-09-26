import "../../index.css";

import type { EnvironmentApi, PullRequestSubmitReviewInput } from "@t3tools/contracts";
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
      detail: async () => PULL_REQUEST_INLINE_REVIEW_DETAIL,
      activity: async () => PULL_REQUEST_INLINE_REVIEW_ACTIVITY,
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

  client.setQueryData(
    pullRequestQueryKeys.detail(environmentId, reference),
    PULL_REQUEST_INLINE_REVIEW_DETAIL,
  );
  client.setQueryData(
    pullRequestQueryKeys.activity(environmentId, reference),
    PULL_REQUEST_INLINE_REVIEW_ACTIVITY,
  );
  client.setQueryData(
    pullRequestQueryKeys.monitorStatus(environmentId, reference),
    createMonitorStatus(),
  );
  client.setQueryData(pullRequestQueryKeys.diffInfinite(environmentId, reference), {
    pages: [PULL_REQUEST_INLINE_REVIEW_DIFF],
    pageParams: [null],
  });

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <PullRequestDetailPanel
          environmentId={environmentId}
          reference={reference}
          onClose={() => undefined}
        />
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
  expect(document.querySelector('[aria-label="Pull request collaboration status"]')).not.toBeNull();
  await page.getByRole("tab", { name: /code/i }).click();
  await expect.element(page.getByText("src/engine.ts")).toBeVisible();
  expect(document.querySelector('[aria-label="Pull request collaboration status"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Add a line comment");
}

describe("PullRequestDetailPanel inline review comments", () => {
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
    await expect.element(submitButton).toBeDisabled();
    expect(submitReview).toHaveBeenCalledTimes(2);
    expect(submitReview).toHaveBeenNthCalledWith(2, expectedReviewInput);
    await expect.element(page.getByText("3 pending line comments")).not.toBeInTheDocument();
    expect(usePullRequestReviewStore.getState().commentsByKey[reviewKey]).toBeUndefined();
  });
});
