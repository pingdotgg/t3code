import { EnvironmentId, SourceControlProviderKind, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const { openLink, useOpenLink } = vi.hoisted(() => {
  const openLink = vi.fn(async () => {});
  return { openLink, useOpenLink: vi.fn((_threadRef: unknown) => openLink) };
});
vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink }));

import { render } from "../../../test/render";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

it("opens the host through the link-target setting, not a popup", async () => {
  await using screen = await render(
    <PullRequestDiffUnavailableState
      error="rate limit"
      provider={SourceControlProviderKind.make("github")}
      url="https://github.com/owner/repo/pull/1"
      threadRef={threadRef}
      onRetry={() => {}}
    />,
  );
  const link = screen.container.querySelector("a")!;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(useOpenLink).toHaveBeenCalledWith(threadRef);
  expect(openLink).toHaveBeenCalledWith("https://github.com/owner/repo/pull/1", {
    event: expect.anything(),
  });
});
