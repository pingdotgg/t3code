import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { type ClosedViewEntry, useClosedViewStore } from "./closedViewStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));
const diff = (threadRef: typeof refA) =>
  ({ kind: "panel-tab", threadRef, surface: { kind: "diff", id: "diff" } }) as const;

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
});

const snapshot: PreviewSessionSnapshot = {
  threadId: refA.threadId,
  tabId: "private-tab",
  profileId: INCOGNITO_BROWSER_PROFILE_ID,
  navStatus: { _tag: "Success", url: "https://private.example", title: "Private page" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-06T17:00:00.000Z",
};

describe("closedViewStore", () => {
  it.each([
    { id: "bad", kind: "browser", threadRef: refA, snapshot: {} },
    {
      id: "bad",
      kind: "browser",
      threadRef: refA,
      snapshot: { ...snapshot, profileId: "default", navStatus: null },
    },
    { id: "bad", kind: "panel-tab", surface: { kind: "diff", id: "diff" } },
    { id: "bad", kind: "panel-tab", threadRef: refA },
    { id: "bad", kind: "panel-tab", threadRef: {}, surface: { kind: "diff", id: "diff" } },
    { id: "bad", kind: "panel-tab", threadRef: refA, surface: {} },
    { id: "bad", kind: "panel-tab", threadRef: refA, surface: { kind: "file", id: "file:x" } },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "device", id: "device:x", target: {} },
    },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "pull-request", id: "pull-request:x", repository: "owner/repo", number: 1 },
    },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "thread", id: "thread:x" },
    },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "linked-thread", id: "linked-thread:x", viaEnvironmentId: "env-1" },
    },
  ])("discards incomplete saved views %j while retaining valid history", async (entry) => {
    const id = useClosedViewStore.getState().remember(diff(refA));
    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: { entries: [entry as ClosedViewEntry, ...useClosedViewStore.getState().entries] },
      version: 1,
    });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.persist.hasHydrated()).toBe(true);
    expect(useClosedViewStore.getState().entries).toEqual([{ ...diff(refA), id }]);
    expect(() => useClosedViewStore.getState().remember(diff(refB))).not.toThrow();
  });

  it("preserves every supported saved panel type and its restore data", async () => {
    const surfaces = [
      { kind: "diff", id: "diff" },
      { kind: "files", id: "files" },
      { kind: "pull-requests", id: "pull-requests" },
      { kind: "preview", id: "browser:new", resourceId: null },
      { kind: "preview", id: "browser:saved", resourceId: "saved" },
      { kind: "canvas", id: "canvas:new", documentId: null },
      { kind: "canvas", id: "canvas:saved", documentId: "saved", title: "Design" },
      { kind: "device", id: "device" },
      {
        kind: "device",
        id: "device:phone",
        title: "My phone",
        target: { hostId: "mac", deviceId: "phone", platform: "ios", name: "iPhone" },
      },
      { kind: "file", id: "file:x", relativePath: "x", revealLine: 12, revealRequestId: 1 },
      {
        kind: "file",
        id: "attachment:a",
        relativePath: "report.pdf",
        revealLine: null,
        revealRequestId: 0,
        attachment: {
          type: "file",
          id: "a",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
        },
      },
      {
        kind: "pull-request",
        id: "pull-request:x",
        projectId: "project",
        repository: "owner/repo",
        number: 1,
        environmentId: "env-1",
        host: "github.com",
        url: "https://github.com/owner/repo/pull/1",
      },
    ];
    const entries = surfaces.map((surface, index) => ({
      id: String(index),
      kind: "panel-tab",
      threadRef: refA,
      surface,
    })) as ClosedViewEntry[];
    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, { state: { entries }, version: 0 });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.persist.hasHydrated()).toBe(true);
    expect(useClosedViewStore.getState().entries).toEqual(entries);
  });

  it("keeps private tabs available in memory without saving their metadata", async () => {
    const store = useClosedViewStore.getState();
    const publicId = store.remember(diff(refA));
    const privateId = store.remember({ kind: "browser", threadRef: refA, snapshot });
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([
      privateId,
      publicId,
    ]);
    const { storage, name } = useClosedViewStore.persist.getOptions();
    const saved = JSON.stringify(await storage!.getItem(name!));
    expect(saved).not.toContain("private.example");
    expect(saved).not.toContain("Private page");
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([publicId]);
  });

  it("removes private metadata and malformed entries from history saved by earlier versions", async () => {
    const store = useClosedViewStore.getState();
    const sideChatId = store.remember({
      kind: "panel-tab",
      threadRef: refA,
      // Saved before a side chat's tab became a `thread` surface.
      surface: { id: "side-chat:side", kind: "side-chat", threadId: "side" } as never,
    });
    const publicId = store.remember(diff(refA));
    const browserId = store.remember({
      kind: "browser",
      threadRef: refA,
      snapshot: {
        ...snapshot,
        tabId: "public-tab",
        profileId: "default",
        navStatus: { _tag: "Success", url: "https://public.example", title: "Public page" },
      },
    });
    store.remember({ kind: "browser", threadRef: refA, snapshot });
    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: {
        entries: [
          null,
          {},
          { kind: "browser" },
          { kind: "browser", snapshot: null },
          ...useClosedViewStore.getState().entries,
        ] as ClosedViewEntry[],
      },
      version: 0,
    });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.persist.hasHydrated()).toBe(true);
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([
      browserId,
      publicId,
      sideChatId,
    ]);
    expect(useClosedViewStore.getState().entries.at(-1)).toMatchObject({
      surface: { id: "thread:side", kind: "thread", threadId: "side" },
    });
    const saved = JSON.stringify(await storage!.getItem(name!));
    expect(saved).not.toContain("private.example");
    expect(saved).not.toContain("Private page");
  });
});
