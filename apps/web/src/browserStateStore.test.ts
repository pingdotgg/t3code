import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { createBrowserTab } from "./browser";
import { selectThreadBrowserState, useBrowserStateStore } from "./browserStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("browserStateStore actions", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
    useBrowserStateStore.setState({ browserStateByThreadId: {} });
  });

  it("returns an empty default state for unknown threads", () => {
    const browserState = selectThreadBrowserState(
      useBrowserStateStore.getState().browserStateByThreadId,
      THREAD_ID,
    );
    expect(browserState).toEqual({
      activeTabId: null,
      tabs: [],
      inputValue: "",
      focusRequestId: 0,
    });
  });

  it("does not rewrite state for no-op updates", () => {
    const tab = { ...createBrowserTab("http://localhost:3000"), id: "tab-1" };
    useBrowserStateStore.setState({
      browserStateByThreadId: {
        [THREAD_ID]: {
          activeTabId: tab.id,
          tabs: [tab],
          inputValue: tab.url,
          focusRequestId: 0,
        },
      },
    });

    const beforeMap = useBrowserStateStore.getState().browserStateByThreadId;
    const beforeEntry = beforeMap[THREAD_ID];
    useBrowserStateStore.getState().updateThreadBrowserState(THREAD_ID, (state) => state);
    const afterMap = useBrowserStateStore.getState().browserStateByThreadId;
    const afterEntry = afterMap[THREAD_ID];

    expect(afterMap).toBe(beforeMap);
    expect(afterEntry).toBe(beforeEntry);
    expect(afterEntry?.tabs).toBe(beforeEntry?.tabs);
  });
});
