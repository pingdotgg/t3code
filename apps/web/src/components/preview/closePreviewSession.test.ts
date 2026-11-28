import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { useClosedViewStore } from "~/closedViewStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { followPreviewSessions, startAgentOpenedPreviews } from "./agentOpenedPreviews";
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
  if (!Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(primaryEnvironmentIdAtom)) {
    throw new Error("primaryEnvironmentIdAtom is not writable");
  }
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

  it("keeps a tab this desktop renders mounted until the server has closed it", async () => {
    setPrimaryEnvironment(threadRef.environmentId);
    const desktopSnapshot = { ...snapshot, runtime: "server" as const };
    applyPreviewServerSnapshot(threadRef, desktopSnapshot);
    let finishClose: (() => void) | undefined;
    const closing = closePreviewSession({
      closePreview: () =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
      snapshot: desktopSnapshot,
      tabId: desktopSnapshot.tabId,
      threadRef,
    });

    expect(readThreadPreviewState(threadRef).sessions).toEqual({ "tab-1": desktopSnapshot });
    finishClose?.();
    await closing;
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    applyPreviewServerSnapshot(threadRef, desktopSnapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
  });

  it("keeps a closed desktop tab out of the panel while its close is in flight", async () => {
    setPrimaryEnvironment(threadRef.environmentId);
    useRightPanelStore.setState({ byThreadKey: {} });
    const closingTab = { ...snapshot, runtime: "server" as const };
    const otherTab = { ...closingTab, tabId: "tab-2" };
    applyPreviewServerSnapshot(threadRef, closingTab);
    applyPreviewServerSnapshot(threadRef, otherTab);
    followPreviewSessions(threadRef, readThreadPreviewState(threadRef));
    const browserTabs = () =>
      useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.filter(
          (surface) => surface.kind === "preview",
        )
        .map((surface) => surface.id);
    expect(browserTabs()).toEqual(["browser:tab-1", "browser:tab-2"]);

    useRightPanelStore.getState().closeSurfaces(threadRef, ["browser:tab-1"]);
    let finishClose: (() => void) | undefined;
    const closing = closePreviewSession({
      closePreview: () =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
      snapshot: closingTab,
      tabId: closingTab.tabId,
      threadRef,
    });
    expect(browserTabs()).toEqual(["browser:tab-2"]);

    // Another tab's update arrives while the server is still unloading the closed page.
    applyPreviewServerSnapshot(threadRef, {
      ...otherTab,
      updatedAt: "2026-06-18T19:00:01.000Z",
    });
    followPreviewSessions(threadRef, readThreadPreviewState(threadRef));
    expect(browserTabs()).toEqual(["browser:tab-2"]);

    finishClose?.();
    await closing;
  });

  it("keeps every desktop tab of a bulk close out of the panel while their closes are in flight", async () => {
    setPrimaryEnvironment(threadRef.environmentId);
    useRightPanelStore.setState({ byThreadKey: {} });
    const stopFollowing = startAgentOpenedPreviews();
    const tabs = ["tab-1", "tab-2", "tab-3"].map((tabId) => ({
      ...snapshot,
      tabId,
      runtime: "server" as const,
    }));
    for (const tab of tabs) applyPreviewServerSnapshot(threadRef, tab);
    const browserTabs = () =>
      useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.filter(
          (surface) => surface.kind === "preview",
        )
        .map((surface) => surface.id);
    expect(browserTabs()).toEqual(["browser:tab-1", "browser:tab-2", "browser:tab-3"]);

    // Close all: the panel drops every surface, then releases each session in turn.
    const [first, second, third] = tabs;
    useRightPanelStore.getState().closeSurfaces(threadRef, ["browser:tab-1", "browser:tab-2"]);
    const finishers: Array<() => void> = [];
    const closes = [first!, second!].map((tab) =>
      closePreviewSession({
        closePreview: () =>
          new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
            finishers.push(() => resolve(AsyncResult.success(undefined)));
          }),
        snapshot: tab,
        tabId: tab.tabId,
        threadRef,
      }),
    );
    expect(browserTabs()).toEqual(["browser:tab-3"]);

    applyPreviewServerSnapshot(threadRef, { ...third!, updatedAt: "2026-06-18T19:00:01.000Z" });
    expect(browserTabs()).toEqual(["browser:tab-3"]);

    finishers[0]?.();
    await closes[0];
    expect(browserTabs()).toEqual(["browser:tab-3"]);
    finishers[1]?.();
    await closes[1];
    expect(browserTabs()).toEqual(["browser:tab-3"]);
    stopFollowing();
  });
});
