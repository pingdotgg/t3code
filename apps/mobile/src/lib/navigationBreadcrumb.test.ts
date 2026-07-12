import { describe, expect, it } from "vite-plus/test";

import { routePathFromNavigationState } from "./navigationBreadcrumb";

describe("routePathFromNavigationState", () => {
  it("joins nested active routes", () => {
    expect(
      routePathFromNavigationState({
        index: 0,
        routes: [
          {
            key: "root",
            name: "Root",
            state: {
              index: 1,
              routes: [
                { key: "home", name: "Home" },
                { key: "thread", name: "Thread" },
              ],
            },
          },
        ],
      }),
    ).toBe("Root/Thread");
  });

  it("returns empty for missing state", () => {
    expect(routePathFromNavigationState(undefined)).toBe("");
  });
});
