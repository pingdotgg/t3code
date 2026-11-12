import { createRef } from "react";
import { getRenderablePatch } from "~/lib/diffRendering";
import { GuideStop, type GuideStopHandle } from "./guide/GuideStop";
import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const identity = vi.hoisted(() => ({ viewer: "alice", ready: true }));
vi.mock(import("./usePullRequestReviewKey"), async () => {
  const { pullRequestReviewKey } = await import("./pullRequestReviewStore");
  const key = (environmentId: EnvironmentId, reference: PullRequestRef) =>
    pullRequestReviewKey(reference, { environmentId, viewer: identity.viewer });
  return {
    usePullRequestReviewKey: key,
    usePullRequestReviewScope: (environmentId: EnvironmentId, reference: PullRequestRef) => ({
      key: key(environmentId, reference),
      ready: identity.ready,
    }),
  };
});
vi.mock(import("./guide/useGuideDiffFiles"), () => ({ useGuideDiffFiles: vi.fn() }));
import { useGuideDiffFiles } from "./guide/useGuideDiffFiles";

function setup() {
  identity.viewer = "alice";
  identity.ready = true;
  vi.mocked(useReviewGuideWriter).mockReset();
  vi.mocked(useGuideDiffFiles).mockReset();
}

vi.mock(import("./guide/useReviewGuideWriter"), () => ({ useReviewGuideWriter: vi.fn() }));

import { render } from "../../../test/render";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import { PullRequestGuideTab } from "./PullRequestGuideTab";

const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number: 1,
};

const verboseFailure = [
  "Codex CLI command failed: OpenAI Codex v0.164.0",
  ...Array.from({ length: 200 }, (_, line) => `prompt line ${line}: read the change in order`),
  "ERROR: provider auth command `sh` timed out after 5000 ms",
].join("\n");

it("keeps Try again inside a short panel when a failed guide has long diagnostics", async () => {
  setup();
  const write = vi.fn(async () => {});
  vi.mocked(useReviewGuideWriter).mockReturnValue({
    query: { isPending: false, error: null } as never,
    data: {
      guide: null,
      run: {
        _tag: "Failed",
        headSha: "head",
        failedAt: "2026-10-27T16:37:47.661Z",
        detail: verboseFailure,
      },
      currentHeadSha: "head",
    },
    running: false,
    canWrite: true,
    write,
  });
  const panel = document.createElement("div");
  panel.style.cssText = "position: relative; width: 480px; height: 360px; overflow: hidden";
  const tab = document.createElement("div");
  tab.style.cssText = "position: absolute; inset: 0";
  panel.append(tab);
  document.body.append(panel);
  using _panel = { [Symbol.dispose]: () => panel.remove() };

  await using screen = await render(
    <PullRequestGuideTab
      environmentId={EnvironmentId.make("environment")}
      reference={reference}
      title="Test pull request"
      workspaceRoot="/workspace"
      renderFallback={(status) => <div className="h-full overflow-y-auto px-4 py-5">{status}</div>}
      viewControlsTarget={null}
      detail={{
        reviewThreads: [],
        capabilities: {
          diff: true,
          comment: false,
          actions: [],
          mergeMethods: [],
          search: true,
          review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
          reviewers: { request: false, listCandidates: false },
        },
      }}
      active
      canComment={false}
      rangeComments={false}
      completionScope={null}
      onAskAboutLines={null}
      onAskAboutStop={null}
      onFinishReview={null}
      onOpenFile={() => {}}
    />,
    { container: tab },
  );

  const retry = screen.getByRole("button", { name: "Try again" });
  await expect.element(retry).toBeVisible();
  const panelBox = panel.getBoundingClientRect();
  const retryBox = retry.element().getBoundingClientRect();
  expect(retryBox.top).toBeGreaterThanOrEqual(panelBox.top);
  expect(retryBox.bottom).toBeLessThanOrEqual(panelBox.bottom);

  await userEvent.click(retry);
  expect(write).toHaveBeenCalledOnce();
});

it("keeps excerpt files out of full-file panels and reveals their excerpt from the rail", async () => {
  setup();
  const parsed = getRenderablePatch(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      "-before()",
      "+after()",
      " other()",
      " outside_excerpt()",
      "",
    ].join("\n"),
    "guide-stop-regression",
  );
  if (parsed?.kind !== "files") throw new Error("Expected a parsed diff");
  const navigationRef = createRef<GuideStopHandle>();
  const container = document.createElement("div");
  container.className = "h-[200px] w-[900px] overflow-auto";
  container.setAttribute("data-guide-diff-scroll", "");
  await using screen = await render(
    <GuideStop
      navigationRef={navigationRef}
      stop={{
        title: "Chapter",
        summary: "",
        attention: null,
        excerpts: [{ path: "a.ts", side: "new", start: 1, end: 1, caption: "Excerpt" }],
        files: [{ path: "a.ts", note: "" }],
        notes: [],
        questions: [],
      }}
      index={0}
      stopCount={1}
      railOpen={false}
      onRailOpenChange={() => {}}
      stopList={null}
      nextTitle={null}
      files={new Map([["a.ts", parsed.files[0]!]])}
      loadDiffFiles={async () => ({
        oldFile: { name: "a.ts", contents: "before()\nother()\noutside_excerpt()\n" },
        newFile: { name: "a.ts", contents: "after()\nother()\noutside_excerpt()\n" },
      })}
      diffLoading={false}
      commenting={null}
      onStep={() => {}}
      onAsk={null}
      onFinish={null}
      onOpenFile={() => {}}
      isViewed={() => false}
      onSetViewed={null}
    />,
    { container },
  );
  await expect.element(screen.getByText("after()", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("outside_excerpt()", { exact: true }))
    .not.toBeInTheDocument();
  using scroll = vi.spyOn(container, "scrollTo");
  navigationRef.current!.revealFile("a.ts");
  await vi.waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: expect.any(Number) }));
  await expect
    .element(screen.getByText("outside_excerpt()", { exact: true }))
    .not.toBeInTheDocument();
});

it("scopes mounted guide drafts to the current ready account", async () => {
  setup();
  const parsed = getRenderablePatch(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before()\n+after()\n",
    "guide-owner",
  );
  if (parsed?.kind !== "files") throw new Error("Expected a parsed diff");
  vi.mocked(useGuideDiffFiles).mockReturnValue({
    files: new Map([["a.ts", parsed.files[0]!]]),
    loading: false,
    error: null,
    retry: () => {},
  });
  vi.mocked(useReviewGuideWriter).mockReturnValue({
    query: { isPending: false, error: null },
    data: {
      guide: {
        headSha: "head",
        stops: [
          {
            title: "Chapter",
            summary: "",
            attention: null,
            excerpts: [{ path: "a.ts", side: "new", start: 1, end: 1, caption: "" }],
            files: [],
            notes: [],
            questions: [],
          },
        ],
      },
      currentHeadSha: "head",
      run: null,
    },
    running: false,
    canWrite: false,
    write: vi.fn(),
  } as never);
  const container = document.createElement("div");
  container.className = "h-[700px] w-[900px]";
  const ui = () => (
    <PullRequestGuideTab
      environmentId={EnvironmentId.make("environment")}
      reference={reference}
      title="PR"
      workspaceRoot="/workspace"
      renderFallback={() => null}
      viewControlsTarget={null}
      detail={{
        reviewThreads: [],
        capabilities: {
          diff: true,
          comment: true,
          actions: [],
          mergeMethods: [],
          search: true,
          review: { inlineComment: true, reply: false, resolve: false, verdicts: [] },
          reviewers: { request: false, listCandidates: false },
        },
      }}
      active
      canComment
      rangeComments={false}
      completionScope={null}
      onAskAboutLines={() => {}}
      onAskAboutStop={null}
      onFinishReview={null}
      onOpenFile={() => {}}
    />
  );
  await using screen = await render(ui(), { container });
  const select = async () => {
    await expect.element(screen.getByText("after()", { exact: true })).toBeVisible();
    const root = screen.getByText("after()", { exact: true }).element().getRootNode() as ShadowRoot;
    await userEvent.click(
      page.elementLocator(
        root.querySelector<HTMLElement>(
          '[data-column-number="1"][data-line-type="change-addition"]',
        )!,
      ),
    );
  };
  await select();
  await screen.getByRole("textbox").fill("Alice private guide feedback");
  identity.viewer = "bob";
  await screen.rerender(ui());
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  identity.ready = false;
  await screen.rerender(ui());
  await select();
  await expect
    .element(screen.getByRole("button", { name: "Add to review", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Add to composer", exact: true }))
    .toBeVisible();
});
