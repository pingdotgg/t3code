import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcilePreviewThreadRefs } from "./previewThreadLifecycle";

const environmentOne = EnvironmentId.make("env-1");
const environmentTwo = EnvironmentId.make("env-2");
const activeRef = scopeThreadRef(environmentOne, ThreadId.make("thread-active"));
const archivedRef = scopeThreadRef(environmentOne, ThreadId.make("thread-archived"));
const deletedRef = scopeThreadRef(environmentTwo, ThreadId.make("thread-deleted"));

describe("reconcilePreviewThreadRefs", () => {
  it("finds removed preview state only in live environment shells", () => {
    expect(
      reconcilePreviewThreadRefs({
        previousActiveThreadRefs: [activeRef, archivedRef, deletedRef],
        activeThreadRefs: [activeRef],
        liveEnvironmentIds: new Set([environmentOne]),
      }),
    ).toEqual({
      removedThreadRefs: [archivedRef],
      nextActiveThreadRefs: [deletedRef, activeRef],
    });
  });

  it("retains the prior baseline until shell synchronization completes", () => {
    const synchronizing = reconcilePreviewThreadRefs({
      previousActiveThreadRefs: [activeRef, archivedRef],
      activeThreadRefs: [activeRef],
      liveEnvironmentIds: new Set(),
    });
    expect(synchronizing).toEqual({
      removedThreadRefs: [],
      nextActiveThreadRefs: [activeRef, archivedRef],
    });

    expect(
      reconcilePreviewThreadRefs({
        previousActiveThreadRefs: synchronizing.nextActiveThreadRefs,
        activeThreadRefs: [activeRef],
        liveEnvironmentIds: new Set([environmentOne]),
      }),
    ).toEqual({
      removedThreadRefs: [archivedRef],
      nextActiveThreadRefs: [activeRef],
    });
  });

  it("does not report unchanged reordered thread references", () => {
    expect(
      reconcilePreviewThreadRefs({
        previousActiveThreadRefs: [activeRef, archivedRef],
        activeThreadRefs: [{ ...archivedRef }, { ...activeRef }],
        liveEnvironmentIds: new Set([environmentOne]),
      }).removedThreadRefs,
    ).toEqual([]);
  });
});
