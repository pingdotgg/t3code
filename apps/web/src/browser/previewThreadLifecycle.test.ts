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
        catalogEnvironmentIds: new Set([environmentOne, environmentTwo]),
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
      catalogEnvironmentIds: new Set([environmentOne]),
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
        catalogEnvironmentIds: new Set([environmentOne]),
        liveEnvironmentIds: new Set([environmentOne]),
      }),
    ).toEqual({
      removedThreadRefs: [archivedRef],
      nextActiveThreadRefs: [activeRef],
    });
  });

  it("removes retained preview state when an environment leaves the catalog", () => {
    expect(
      reconcilePreviewThreadRefs({
        previousActiveThreadRefs: [activeRef, deletedRef],
        activeThreadRefs: [activeRef],
        catalogEnvironmentIds: new Set([environmentOne]),
        liveEnvironmentIds: new Set([environmentOne]),
      }),
    ).toEqual({
      removedThreadRefs: [deletedRef],
      nextActiveThreadRefs: [activeRef],
    });
  });

  it("retains the prior baseline while the environment catalog is unavailable", () => {
    expect(
      reconcilePreviewThreadRefs({
        previousActiveThreadRefs: [activeRef, deletedRef],
        activeThreadRefs: [],
        catalogEnvironmentIds: null,
        liveEnvironmentIds: new Set(),
      }),
    ).toEqual({
      removedThreadRefs: [],
      nextActiveThreadRefs: [activeRef, deletedRef],
    });
  });

  it("refreshes live baselines while the environment catalog is unavailable", () => {
    expect(
      reconcilePreviewThreadRefs({
        previousActiveThreadRefs: [archivedRef],
        activeThreadRefs: [activeRef],
        catalogEnvironmentIds: null,
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
        catalogEnvironmentIds: new Set([environmentOne]),
        liveEnvironmentIds: new Set([environmentOne]),
      }).removedThreadRefs,
    ).toEqual([]);
  });
});
