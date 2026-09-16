import type { ContextMenuItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  openOnHostLabel,
  showPullRequestLinkContextMenu,
  type PullRequestLinkContextMenuAction,
} from "./pullRequestLinkContextMenu";

type Items = readonly ContextMenuItem<PullRequestLinkContextMenuAction>[];

const URL = "https://github.com/pingdotgg/t3code/pull/23";

/**
 * Opens the menu against a stubbed desktop bridge and hands back what it offered.
 *
 * These suites run on node, so the bridge `readLocalApi` reaches for is stood up here rather than
 * in a DOM. Going through the exported entry point rather than the items helper keeps the test on
 * the surface callers actually use.
 */
async function openMenu(
  options: {
    readonly unlinkFromThread?: ((url: string) => Promise<void>) | undefined;
    readonly url?: string;
  },
  choose: PullRequestLinkContextMenuAction | null = null,
): Promise<Items> {
  let items: Items = [];
  const globals = globalThis as { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    desktopBridge: {
      showContextMenu: async (shown: Items) => {
        items = shown;
        return choose;
      },
    },
  };
  try {
    await showPullRequestLinkContextMenu({
      url: options.url ?? URL,
      openLabel: "Open on GitHub",
      position: { x: 0, y: 0 },
      ...(options.unlinkFromThread ? { unlinkFromThread: options.unlinkFromThread } : {}),
    });
  } finally {
    globals.window = previousWindow;
  }
  return items;
}

describe("pull request link context menu", () => {
  it("names every host it knows, and says nothing false about one it does not", () => {
    expect(openOnHostLabel("github")).toBe("Open on GitHub");
    expect(openOnHostLabel("gitlab")).toBe("Open on GitLab");
    expect(openOnHostLabel("bitbucket")).toBe("Open on Bitbucket");
    expect(openOnHostLabel("azure-devops")).toBe("Open on Azure DevOps");
    expect(openOnHostLabel("something-else")).toBe("Open on host");
  });

  it("leaves unlinking out until the caller says this number is the thread's own", async () => {
    expect(await openMenu({})).toEqual([
      { id: "copy-link", label: "Copy link", icon: "copy" },
      { id: "open-external", label: "Open on GitHub" },
    ]);
  });

  it("puts unlinking last, behind a divider, so a misclick lands on copy instead", async () => {
    expect(await openMenu({ unlinkFromThread: async () => {} })).toEqual([
      { id: "copy-link", label: "Copy link", icon: "copy" },
      { id: "open-external", label: "Open on GitHub" },
      { id: "unlink-from-thread", label: "Unlink #23 from thread", separatorBefore: true },
    ]);
  });

  it("falls back to the bare label for a url it cannot read a number out of", async () => {
    const items = await openMenu({
      url: "https://example.com/some/page",
      unlinkFromThread: async () => {},
    });
    expect(items.at(-1)).toEqual({
      id: "unlink-from-thread",
      label: "Unlink from thread",
      separatorBefore: true,
    });
  });

  it("tells the unlink callback which url was acted on, so a stale menu can decline", async () => {
    const acted: string[] = [];
    await openMenu(
      {
        unlinkFromThread: async (url) => {
          acted.push(url);
        },
      },
      "unlink-from-thread",
    );
    expect(acted).toEqual([URL]);
  });
});
