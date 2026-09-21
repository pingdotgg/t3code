import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcileAuthoritativeThreadRefs } from "./authoritativeThreadLifecycle";

const environmentOne = EnvironmentId.make("env-1");
const environmentTwo = EnvironmentId.make("env-2");
const activeRef = scopeThreadRef(environmentOne, ThreadId.make("thread-active"));
const archivedRef = scopeThreadRef(environmentOne, ThreadId.make("thread-archived"));
const deletedRef = scopeThreadRef(environmentTwo, ThreadId.make("thread-deleted"));

describe("reconcileAuthoritativeThreadRefs", () => {
  it("finds removed thread state only in live environment shells", () => {
    expect(
      reconcileAuthoritativeThreadRefs({
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
    const synchronizing = reconcileAuthoritativeThreadRefs({
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
      reconcileAuthoritativeThreadRefs({
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

  it("removes retained thread state when an environment leaves the catalog", () => {
    expect(
      reconcileAuthoritativeThreadRefs({
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
      reconcileAuthoritativeThreadRefs({
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
      reconcileAuthoritativeThreadRefs({
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
      reconcileAuthoritativeThreadRefs({
        previousActiveThreadRefs: [activeRef, archivedRef],
        activeThreadRefs: [{ ...archivedRef }, { ...activeRef }],
        catalogEnvironmentIds: new Set([environmentOne]),
        liveEnvironmentIds: new Set([environmentOne]),
      }).removedThreadRefs,
    ).toEqual([]);
  });
});
