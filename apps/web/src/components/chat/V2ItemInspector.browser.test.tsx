import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const url = "https://example.com/search-result";

const projectedItem = vi.hoisted(() => ({
  position: 0,
  visibility: "local",
  sourceThreadId: "thread-1",
  sourceItemId: "search",
  item: {
    id: "search",
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: {},
    type: "web_search",
    patterns: ["some query"],
    results: [{ title: "Example result", url: "https://example.com/search-result" }],
  },
}));

const state = vi.hoisted(() => ({ openLink: vi.fn(async () => {}) }));

vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink: () => state.openLink }));

import { V2ItemInspector } from "./V2ItemInspector";

describe("V2ItemInspector", () => {
  it("opens a web search result through the link-target setting, not a popup", async () => {
    await using screen = await render(
      <V2ItemInspector
        projectedItem={projectedItem as never}
        environmentId={"env-1" as never}
        cwd={undefined}
        workspaceRoot={undefined}
        source={undefined}
      />,
      { router: false },
    );
    const link = screen.container.querySelector("a");
    if (!link) throw new Error("the web search result anchor did not render");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(state.openLink).toHaveBeenCalledOnce();
    expect(state.openLink).toHaveBeenCalledWith(url, { event: expect.anything() });
  });
});
