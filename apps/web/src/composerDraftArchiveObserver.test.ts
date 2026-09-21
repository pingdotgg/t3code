import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcileAuthoritativeThreadRefs } from "./authoritativeThreadLifecycle";

const environmentId = EnvironmentId.make("environment-one");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-one"));

function reconcile(
  previousActiveThreadRefs: ReadonlyArray<typeof threadRef>,
  activeThreadRefs: ReadonlyArray<typeof threadRef>,
) {
  return reconcileAuthoritativeThreadRefs({
    previousActiveThreadRefs,
    activeThreadRefs,
    catalogEnvironmentIds: new Set([environmentId]),
    liveEnvironmentIds: new Set([environmentId]),
  });
}

describe("composer draft archive observation", () => {
  it("releases a thread after an authoritative remote archive", () => {
    const afterArchive = reconcile([threadRef], []);

    expect(afterArchive.removedThreadRefs).toEqual([threadRef]);
  });

  it("keeps uploads when shell data is unavailable", () => {
    const unavailable = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: [threadRef],
      activeThreadRefs: [],
      catalogEnvironmentIds: new Set([environmentId]),
      liveEnvironmentIds: new Set(),
    });

    expect(unavailable.removedThreadRefs).toEqual([]);
    expect(unavailable.nextActiveThreadRefs).toEqual([threadRef]);
  });

  it("waits through an authorization session handoff before cleaning an archived draft", () => {
    const synchronizingReplacement = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: [threadRef],
      activeThreadRefs: [],
      catalogEnvironmentIds: new Set([environmentId]),
      liveEnvironmentIds: new Set(),
    });

    expect(synchronizingReplacement.removedThreadRefs).toEqual([]);
    expect(synchronizingReplacement.nextActiveThreadRefs).toEqual([threadRef]);

    const authoritativeReplacement = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: synchronizingReplacement.nextActiveThreadRefs,
      activeThreadRefs: [],
      catalogEnvironmentIds: new Set([environmentId]),
      liveEnvironmentIds: new Set([environmentId]),
    });

    expect(authoritativeReplacement.removedThreadRefs).toEqual([threadRef]);
    expect(authoritativeReplacement.nextActiveThreadRefs).toEqual([]);
  });

  it("releases a cached thread archived before its shell becomes live", () => {
    const cached = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: [],
      activeThreadRefs: [threadRef],
      catalogEnvironmentIds: new Set([environmentId]),
      liveEnvironmentIds: new Set(),
    });

    expect(cached.removedThreadRefs).toEqual([]);
    expect(cached.nextActiveThreadRefs).toEqual([threadRef]);

    const liveAfterArchive = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: cached.nextActiveThreadRefs,
      activeThreadRefs: [],
      catalogEnvironmentIds: new Set([environmentId]),
      liveEnvironmentIds: new Set([environmentId]),
    });

    expect(liveAfterArchive.removedThreadRefs).toEqual([threadRef]);
  });

  it("does not release uploads when an archived thread is unarchived", () => {
    const unarchived = reconcile([], [threadRef]);

    expect(unarchived.removedThreadRefs).toEqual([]);
  });
});
