import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it.each([
    ["loading", "Loading messages..."],
    ["syncing", "Syncing messages..."],
  ] as const)("renders the %s message sync phase", (phase, label) => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase={phase} />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain(label);
    expect(markup).not.toContain("animate-");
  });
});
