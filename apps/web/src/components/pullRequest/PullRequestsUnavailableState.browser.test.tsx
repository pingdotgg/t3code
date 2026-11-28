import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const { openLink, useOpenLink } = vi.hoisted(() => {
  const openLink = vi.fn(async () => {});
  return { openLink, useOpenLink: vi.fn((_threadRef: unknown) => openLink) };
});
vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink }));

import { render } from "../../../test/render";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

it("opens the host through the link-target setting, not a popup", async () => {
  await using screen = await render(
    <PullRequestsUnavailableState
      error="Not found"
      host={{
        url: "https://github.com/owner/repo/pull/1",
        openLabel: "Open on GitHub",
        threadRef,
      }}
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
