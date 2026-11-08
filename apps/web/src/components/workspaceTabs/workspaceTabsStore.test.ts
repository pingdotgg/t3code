import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileTabKey, parseWorkspaceTab, terminalTabKey } from "./workspaceTabsStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(threadRef);

describe("parseWorkspaceTab", () => {
  it("reads persisted thread keys and round-trips file and terminal tabs", () => {
    expect(parseWorkspaceTab(threadKey)).toEqual({ kind: "thread", threadRef });
    expect(parseWorkspaceTab(fileTabKey(threadKey, "src/a:b.ts"))).toEqual({
      kind: "file",
      threadRef,
      path: "src/a:b.ts",
    });
    expect(parseWorkspaceTab(terminalTabKey(threadKey, "term-2"))).toEqual({
      kind: "terminal",
      threadRef,
      terminalId: "term-2",
    });
    expect(parseWorkspaceTab(fileTabKey(threadKey, ""))).toBeNull();
    expect(parseWorkspaceTab("garbage")).toBeNull();
  });
});
