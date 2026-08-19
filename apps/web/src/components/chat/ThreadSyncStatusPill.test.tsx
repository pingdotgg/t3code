import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it("renders loading immediately without participating in composer layout", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="loading" raised={false} />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading messages...");
    expect(markup).toContain("absolute");
    expect(markup).toContain("calc(100% + 0.5rem)");
    expect(markup).not.toContain("animate-");
  });

  it("withholds the cached-thread syncing phase initially", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="syncing" raised={false} />);

    expect(markup).toBe("");
  });

  it("moves above the scroll-to-end control when it is visible", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="loading" raised />);

    expect(markup).toContain("calc(100% + 2.75rem)");
  });
});
