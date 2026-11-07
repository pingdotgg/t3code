import { describe, expect, it } from "vite-plus/test";

import { rootStackRoutesUnchanged } from "./root-stack-reset";

describe("rootStackRoutesUnchanged", () => {
  it("is true when route keys and names match", () => {
    expect(
      rootStackRoutesUnchanged(
        {
          key: "root",
          index: 0,
          routeNames: ["Home"],
          stale: false,
          type: "stack",
          routes: [{ key: "home", name: "Home" }],
        },
        { index: 0, routes: [{ key: "home", name: "Home" }] },
      ),
    ).toBe(true);
  });

  it("is false when leaving a detail route", () => {
    expect(
      rootStackRoutesUnchanged(
        {
          key: "root",
          index: 1,
          routeNames: ["Home", "Thread"],
          stale: false,
          type: "stack",
          routes: [
            { key: "home", name: "Home" },
            { key: "thread", name: "Thread" },
          ],
        },
        { index: 0, routes: [{ key: "home", name: "Home" }] },
      ),
    ).toBe(false);
  });
});
