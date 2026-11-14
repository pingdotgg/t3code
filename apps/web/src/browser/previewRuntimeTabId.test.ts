import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { previewRuntimeTabId } from "./previewRuntimeTabId";

describe("previewRuntimeTabId", () => {
  it("rejects a pinned operation target after the server epoch changes", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const runtimeTabId = previewRuntimeTabId(ref, "epoch-a", "tab_1");

    expect(previewRuntimeTabId(ref, "epoch-a", "tab_1")).toBe(runtimeTabId);
    expect(previewRuntimeTabId(ref, "epoch-b", "tab_1")).not.toBe(runtimeTabId);
  });
});
