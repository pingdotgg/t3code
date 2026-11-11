import { describe, expect, it } from "vite-plus/test";

import { quickActionsProps } from "./quickActionsSnapshot";

describe("quickActionsProps", () => {
  it("links the last thread with its ids encoded once", () => {
    expect(
      quickActionsProps("t3code://", [
        { environmentId: "env", threadId: "thread:project:1", title: " " },
      ]),
    ).toEqual({
      newThreadUrl: "t3code://new",
      lastThread: { title: "Thread", url: "t3code://threads/env/thread%3Aproject%3A1" },
    });
  });

  it("omits the last thread until one was opened", () => {
    expect(quickActionsProps("t3code://", [])).toEqual({ newThreadUrl: "t3code://new" });
  });
});
