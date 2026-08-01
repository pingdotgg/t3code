import { describe, expect, it } from "vitest";

import { resolveThreadAuxiliaryRouteAction } from "./threadAuxiliaryRoute";

describe("thread auxiliary routes", () => {
  it("toggles the active Browser or Files route closed", () => {
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: "browser",
        target: "browser",
        persistentFileInspector: true,
      }),
    ).toBe("close");
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: "files",
        target: "files",
        persistentFileInspector: true,
      }),
    ).toBe("close");
  });

  it("replaces one auxiliary route with the other", () => {
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: "browser",
        target: "files",
        persistentFileInspector: true,
      }),
    ).toBe("replace");
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: "files",
        target: "browser",
        persistentFileInspector: true,
      }),
    ).toBe("replace");
  });

  it("keeps Files in the workspace inspector when no auxiliary route is active", () => {
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: null,
        target: "files",
        persistentFileInspector: true,
      }),
    ).toBe("show-inspector");
  });

  it("navigates when Browser or compact Files needs its own route", () => {
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: null,
        target: "browser",
        persistentFileInspector: true,
      }),
    ).toBe("navigate");
    expect(
      resolveThreadAuxiliaryRouteAction({
        current: null,
        target: "files",
        persistentFileInspector: false,
      }),
    ).toBe("navigate");
  });
});
