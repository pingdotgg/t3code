import { describe, expect, it } from "vite-plus/test";

import {
  readRememberedNavigationState,
  rememberNavigationState,
  resetRememberedNavigationStateForTests,
} from "./navigationPersistence";

describe("navigationPersistence", () => {
  it("keeps the last stack across a remount", () => {
    resetRememberedNavigationStateForTests();
    rememberNavigationState({
      index: 1,
      key: "stack",
      routeNames: ["Home", "Settings"],
      routes: [
        { key: "home", name: "Home" },
        { key: "settings", name: "Settings" },
      ],
      stale: false,
      type: "stack",
    });

    expect(readRememberedNavigationState()).toMatchObject({
      index: 1,
      routes: [{ name: "Home" }, { name: "Settings" }],
    });
  });
});
