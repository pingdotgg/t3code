import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
      active
      canComment={false}
      rangeComments={false}
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
