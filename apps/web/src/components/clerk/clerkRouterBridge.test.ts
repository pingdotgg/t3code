import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { createClerkRouterBridge } from "./clerkRouterBridge";

describe("createClerkRouterBridge", () => {
  it("absorbs a Clerk virtual-router path instead of feeding it to the app history", () => {
    const history = createMemoryHistory({ initialEntries: ["/settings/connections"] });
    const { routerPush } = createClerkRouterBridge(history);

    routerPush("/CLERK-ROUTER/VIRTUAL/sign-up#/continue");

    // The app-router-bound history must be untouched: if it had received
    // this path, the app's router would try to match it and, finding
    // nothing real, blank the whole UI behind the modal to "Not Found".
    expect(history.location.pathname).toBe("/settings/connections");
  });

  it("absorbs a Clerk virtual-router path even when the marker appears after a hash", () => {
    const history = createMemoryHistory({ initialEntries: ["/settings/connections"] });
    const { routerReplace } = createClerkRouterBridge(history);

    routerReplace("/#/CLERK-ROUTER/VIRTUAL/factor-one");

    expect(history.location.pathname).toBe("/settings/connections");
  });

  it("forwards a genuine in-app navigation to the real router history", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const { routerReplace } = createClerkRouterBridge(history);

    routerReplace("/settings/connections");

    expect(history.location.pathname).toBe("/settings/connections");
  });

  it("unwraps a hash-embedded real destination instead of double-hashing it", () => {
    // authRedirect.ts builds Electron redirect targets as
    // t3code://app/#/current-page; clerk-js hands this bridge everything
    // after the origin, hash included. Pushing that string unmodified into
    // a hash history would land on "/#/#/settings/connections" and resolve
    // to the wrong page.
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const { routerPush } = createClerkRouterBridge(history);

    routerPush("/#/settings/connections");

    expect(history.location.pathname).toBe("/settings/connections");
  });
});
