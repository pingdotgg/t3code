import { describe, expect, it } from "vite-plus/test";

import { openRouterSourceId } from "./AddUsageLimitSourceDialog";

describe("openRouterSourceId", () => {
  it("uses the plain id when nothing has claimed it", () => {
    expect(openRouterSourceId("", new Set())).toBe("openrouter");
    expect(openRouterSourceId("Work", new Set())).toBe("openrouter-work");
  });

  // Settings merge by id and the server keys the secret store off it, so a
  // reused id would replace the first account's key rather than add a second.
  it("never hands back an id an existing source already holds", () => {
    expect(openRouterSourceId("", new Set(["openrouter"]))).toBe("openrouter-2");
    expect(openRouterSourceId("", new Set(["openrouter", "openrouter-2"]))).toBe("openrouter-3");
    expect(openRouterSourceId("Work", new Set(["openrouter-work"]))).toBe("openrouter-work-2");
  });

  it("separates labels that normalize to the same slug", () => {
    const first = openRouterSourceId("Work", new Set());
    const second = openRouterSourceId("work!", new Set([first]));
    expect(first).toBe("openrouter-work");
    expect(second).toBe("openrouter-work-2");
  });

  it("ignores unrelated ids when picking a suffix", () => {
    expect(openRouterSourceId("", new Set(["cliproxy-hub", "openrouter-work"]))).toBe("openrouter");
  });
});
