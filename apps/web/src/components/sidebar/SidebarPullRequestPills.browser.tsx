import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarPullRequestPills } from "./SidebarPullRequestPills";

describe("SidebarPullRequestPills", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders distinct pill treatments for open, merged, and closed pull requests", async () => {
    const screen = await render(
      <SidebarPullRequestPills
        references={[
          {
            url: "https://github.com/openai/codex/pull/54",
            number: "54",
            state: "open",
          },
          {
            url: "https://github.com/openai/codex/pull/55",
            number: "55",
            state: "merged",
          },
          {
            url: "https://github.com/openai/codex/pull/56",
            number: "56",
            state: "closed",
          },
        ]}
        onOpenPullRequest={vi.fn()}
      />,
    );

    try {
      const openPill = screen.getByTestId("sidebar-pr-pill-54").element();
      const mergedPill = screen.getByTestId("sidebar-pr-pill-55").element();
      const closedPill = screen.getByTestId("sidebar-pr-pill-56").element();

      expect(openPill.className).toContain("text-emerald-700");
      expect(mergedPill.className).toContain("text-violet-700");
      expect(closedPill.className).toContain("text-rose-700");
    } finally {
      await screen.unmount();
    }
  });

  it("opens the referenced pull request when a pill is clicked", async () => {
    const openPullRequest = vi.fn();
    const screen = await render(
      <SidebarPullRequestPills
        references={[
          {
            url: "https://github.com/openai/codex/pull/54",
            number: "54",
            state: "open",
          },
        ]}
        onOpenPullRequest={openPullRequest}
      />,
    );

    try {
      await page.getByRole("button", { name: "Open pull request #54 (open)" }).click();
      expect(openPullRequest).toHaveBeenCalledTimes(1);
      expect(openPullRequest.mock.calls[0]?.[1]).toBe("https://github.com/openai/codex/pull/54");
    } finally {
      await screen.unmount();
    }
  });
});
