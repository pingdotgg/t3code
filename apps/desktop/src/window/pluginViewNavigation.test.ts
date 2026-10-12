import { describe, expect, it } from "vite-plus/test";

import { type NavigationFrame, shouldVetoViewFrameNavigation } from "./pluginViewNavigation.ts";

const frame = (
  frameToken: string,
  url: string,
  origin: string,
  parent: NavigationFrame | null,
): NavigationFrame => ({ frameToken, url, origin, parent });

const app = frame("app", "t3code-dev://app/", "t3code-dev://app", null);
const view = frame("view", "about:srcdoc", "null", app);
const wrapper = frame("wrapper", "about:srcdoc", "null", app);
const wrappedView = frame("inner", "about:srcdoc", "null", wrapper);

describe("shouldVetoViewFrameNavigation", () => {
  it("refuses a view navigating itself, including through a policy wrapper", () => {
    for (const target of [view, wrappedView]) {
      for (const url of ["about:blank", "http://127.0.0.1:7391/page.html", "data:text/html,x"]) {
        expect(
          shouldVetoViewFrameNavigation({ url, frame: target, initiator: target, mainFrame: app }),
        ).toBe(true);
      }
    }
  });

  it("refuses a navigation with no known initiator", () => {
    expect(
      shouldVetoViewFrameNavigation({
        url: "http://127.0.0.1:7391/redirect",
        frame: view,
        initiator: null,
        mainFrame: app,
      }),
    ).toBe(true);
  });

  it("lets the app mount, wrap and dispose views", () => {
    const fresh = frame("fresh", "about:blank", "t3code-dev://app", app);
    expect(
      shouldVetoViewFrameNavigation({
        url: "about:srcdoc",
        frame: fresh,
        initiator: app,
        mainFrame: app,
      }),
    ).toBe(false);
    const freshInner = frame("fresh-inner", "about:blank", "null", wrapper);
    expect(
      shouldVetoViewFrameNavigation({
        url: "about:srcdoc",
        frame: freshInner,
        initiator: wrapper,
        mainFrame: app,
      }),
    ).toBe(false);
    expect(
      shouldVetoViewFrameNavigation({
        url: "about:blank",
        frame: view,
        initiator: app,
        mainFrame: app,
      }),
    ).toBe(false);
  });

  it("leaves frames outside views alone", () => {
    const other = frame("other", "https://example.com/", "https://example.com", app);
    expect(
      shouldVetoViewFrameNavigation({
        url: "https://example.com/next",
        frame: other,
        initiator: other,
        mainFrame: app,
      }),
    ).toBe(false);
  });
});
