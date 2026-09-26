import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { isCurrentPreviewRuntimeTab, previewRuntimeTabId } from "./runtimeTabId.ts";

const base = { environmentId: "environment-a", threadId: "thread-a" };

NodeTest.describe("previewRuntimeTabId", () => {
  NodeTest.it("serializes environment, thread, server epoch, and tab id", () => {
    NodeAssert.equal(
      previewRuntimeTabId(base, "epoch-a", "tab_1"),
      JSON.stringify(["environment-a", "thread-a", "epoch-a", "tab_1"]),
    );
  });

  NodeTest.it("scopes process-local tab ids to their environment, thread, and server epoch", () => {
    NodeAssert.notEqual(
      previewRuntimeTabId(base, "epoch-a", "tab_1"),
      previewRuntimeTabId({ ...base, environmentId: "environment-b" }, "epoch-a", "tab_1"),
    );
    NodeAssert.notEqual(
      previewRuntimeTabId(base, "epoch-a", "tab_1"),
      previewRuntimeTabId({ ...base, threadId: "thread-b" }, "epoch-a", "tab_1"),
    );
    NodeAssert.notEqual(
      previewRuntimeTabId(base, "epoch-a", "tab_1"),
      previewRuntimeTabId(base, "epoch-b", "tab_1"),
    );
  });

  NodeTest.it("is stable for the same runtime tab, including a null epoch", () => {
    NodeAssert.equal(
      previewRuntimeTabId(base, null, "tab_1"),
      previewRuntimeTabId(base, null, "tab_1"),
    );
    // A null epoch is a distinct identity, not the absence of one.
    NodeAssert.notEqual(
      previewRuntimeTabId(base, null, "tab_1"),
      previewRuntimeTabId(base, "epoch-a", "tab_1"),
    );
  });
});

NodeTest.describe("isCurrentPreviewRuntimeTab", () => {
  NodeTest.it("rejects a pinned operation target after the server epoch changes", () => {
    const runtimeTabId = previewRuntimeTabId(base, "epoch-a", "tab_1");
    NodeAssert.equal(isCurrentPreviewRuntimeTab(base, "epoch-a", "tab_1", runtimeTabId), true);
    NodeAssert.equal(isCurrentPreviewRuntimeTab(base, "epoch-b", "tab_1", runtimeTabId), false);
  });
});
