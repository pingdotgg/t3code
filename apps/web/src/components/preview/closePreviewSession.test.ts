import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as NodeAssert from "node:assert";
import { Atom, AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";

import { useClosedViewStore } from "~/closedViewStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { closePreviewSession } from "./closePreviewSession";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/state/primaryEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/primaryEnvironment")>()),
  primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null),
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Success",
    url: "http://localhost:3000/",
    title: "Local app",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-18T19:00:00.000Z",
};

const setPrimaryEnvironment = (environmentId: EnvironmentId | null) => {
  NodeAssert.ok(
    Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(primaryEnvironmentIdAtom),
  );
  appAtomRegistry.set(primaryEnvironmentIdAtom, environmentId);
};

beforeEach(() => {
  resetPreviewStateForTests();
  setPrimaryEnvironment(null);
  useClosedViewStore.setState({ entries: [] });
});

describe("closePreviewSession", () => {
  it("suppresses stale server snapshots while the close is in flight", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    let finishClose: (() => void) | undefined;
    const closePreview = vi.fn(
      (_input: PreviewCloseInput) =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
    );

    const closing = closePreviewSession({
      closePreview: ({ input }) => closePreview(input),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(useClosedViewStore.getState().entries).toEqual([]);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    applyPreviewServerSnapshot(threadRef, snapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});

    finishClose?.();
    await closing;
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "browser", threadRef, snapshot },
    ]);
    expect(closePreview).toHaveBeenCalledWith({ threadId: "thread-1", tabId: "tab-1" });
  });

  it("keeps a tab this desktop renders mounted until its close returns", async () => {
    setPrimaryEnvironment(threadRef.environmentId);
    const desktopSnapshot = { ...snapshot, runtime: "server" as const };
    applyPreviewServerSnapshot(threadRef, desktopSnapshot);

    const closing = closePreviewSession({
      closePreview: async () => AsyncResult.success(undefined),
      snapshot: desktopSnapshot,
      tabId: desktopSnapshot.tabId,
      threadRef,
    });

    expect(readThreadPreviewState(threadRef).sessions).toEqual({ "tab-1": desktopSnapshot });
    // The page has unloaded once the close returns, even if its closed event never arrives.
    await closing;
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    // A resize or adjust response sent before the close must not bring the tab back.
    updatePreviewServerSnapshot(threadRef, desktopSnapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
  });
});
