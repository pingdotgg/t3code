import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DesktopPendingSnapShot,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { DesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  beginSnapShotAnimationWhenReady,
  deliverSnapShot,
  dismissFailedSnapShot,
  resolveExistingSnapShotTarget,
  resolveSnapShotTargetOnce,
  resolveSnapShotDeliveryTarget,
} from "./SnapShotCoordinator";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  getPendingSnapShotAnimations,
  setSnapShotAnimationDestination,
  scheduleSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
});

const environmentId = EnvironmentId.make("snap-shot-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("snap-shot-project"));

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

afterEach(() => {
  dismissAllSnapShotAnimations();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window capture failures", () => {
  it("dismisses an older failed capture without disturbing a newer capture", async () => {
    const target = DraftId.make("snap-shot-draft");
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const dismissSnapShotAnimation = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      localStorage: storage,
      desktopBridge: {
        requestSnapShotPermissions: vi.fn(),
        getSnapShotState: vi.fn(),
        checkSnapShotShortcut: vi.fn(),
        setSnapShotShortcutSuppressed: vi.fn(),
        listPendingSnapShots: vi.fn(),
        readSnapShot: vi.fn(),
        acknowledgeSnapShot: vi.fn(),
        onSnapShotEvent: vi.fn(() => () => undefined),
        dismissSnapShotAnimation,
      },
    });
    await beginSnapShotAnimationWhenReady("older", Promise.resolve(target), pendingStarts);
    await beginSnapShotAnimationWhenReady("newer", Promise.resolve(target), pendingStarts);

    dismissFailedSnapShot("older", soundedIds, pendingStarts);

    expect(getPendingSnapShotAnimations().map(({ id }) => id)).toEqual(["newer"]);
    expect(soundedIds).toEqual(new Set(["newer"]));
    expect(dismissSnapShotAnimation).toHaveBeenCalledExactlyOnceWith("older");
  });

  it("does not resurrect a failed capture when its draft becomes ready later", async () => {
    const target = DraftId.make("snap-shot-draft");
    let resolveTarget: ((target: DraftId) => void) | undefined;
    const targetReady = new Promise<DraftId>((resolve) => {
      resolveTarget = resolve;
    });
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const olderStart = beginSnapShotAnimationWhenReady("older", targetReady, pendingStarts);
    await beginSnapShotAnimationWhenReady("newer", Promise.resolve(target), pendingStarts);

    dismissFailedSnapShot("older", soundedIds, pendingStarts);
    resolveTarget?.(target);
    await olderStart;

    expect(getPendingSnapShotAnimations().map(({ id }) => id)).toEqual(["newer"]);
    expect(soundedIds).toEqual(new Set(["newer"]));
    expect(pendingStarts.size).toBe(0);
  });

  it("keeps global failures dismissing all active and pending captures", async () => {
    const target = DraftId.make("snap-shot-draft");
    let resolveTarget: ((target: DraftId) => void) | undefined;
    const targetReady = new Promise<DraftId>((resolve) => {
      resolveTarget = resolve;
    });
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    await beginSnapShotAnimationWhenReady("older", Promise.resolve(target), pendingStarts);
    const newerStart = beginSnapShotAnimationWhenReady("newer", targetReady, pendingStarts);

    dismissFailedSnapShot(undefined, soundedIds, pendingStarts);
    resolveTarget?.(target);
    await newerStart;

    expect(getPendingSnapShotAnimations()).toEqual([]);
    expect(soundedIds.size).toBe(0);
    expect(pendingStarts.size).toBe(0);
  });
});

describe("window capture delivery", () => {
  it.each([
    { target: DraftId.make("snap-shot-draft"), accessibleText: undefined },
    { target: DraftId.make("snap-shot-draft"), accessibleText: "const answer = 42;" },
    {
      target: scopeThreadRef(environmentId, ThreadId.make("snap-shot-thread")),
      accessibleText: undefined,
    },
    {
      target: scopeThreadRef(environmentId, ThreadId.make("snap-shot-thread")),
      accessibleText: "const answer = 42;",
    },
  ])(
    "preserves capture contents for $target before a stalled animation finishes ($accessibleText)",
    async ({ target, accessibleText }) => {
      vi.useFakeTimers();
      const never = new Promise<void>(() => undefined);
      const animationFrames: Array<FrameRequestCallback> = [];
      const acknowledgeSnapShot = vi.fn(async () => undefined);
      const bridge = {
        requestSnapShotPermissions: vi.fn(async () => undefined),
        getSnapShotState: vi.fn(),
        checkSnapShotShortcut: vi.fn(),
        setSnapShotShortcutSuppressed: vi.fn(async () => undefined),
        listPendingSnapShots: vi.fn(async () => []),
        readSnapShot: vi.fn(async () => ({
          id: "12345678-1234-1234-1234-123456789abc",
          name: "window.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,AQID",
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-09-01T00:00:00.000Z",
            appName: "Editor",
            windowTitle: "main.ts",
            ...(accessibleText ? { accessibleText } : {}),
          },
        })),
        acknowledgeSnapShot,
        setSnapShotAnimationDestination: vi.fn(() => never),
        onMenuAction: vi.fn(() => () => undefined),
        onSnapShotEvent: vi.fn(() => () => undefined),
      } as unknown as DesktopSnapShotBridge;
      const item: DesktopPendingSnapShot = {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "window.png",
        mimeType: "image/png",
        sizeBytes: 3,
        source: {
          kind: "snap-shot",
          capturedAt: "2026-09-01T00:00:00.000Z",
          appName: "Editor",
          windowTitle: "main.ts",
          ...(accessibleText ? { accessibleText } : {}),
        },
      };
      vi.stubGlobal("window", {
        localStorage: storage,
        desktopBridge: bridge,
        setTimeout,
        clearTimeout,
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({
          backgroundColor: "rgb(0, 0, 0)",
          borderTopColor: "rgb(255, 255, 255)",
          borderTopLeftRadius: "8px",
          borderTopWidth: "1px",
        }),
        dispatchEvent: vi.fn(),
      });
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });

      if (typeof target === "string") {
        useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, target, {
          threadId: ThreadId.make("snap-shot-draft-thread"),
        });
      }
      beginSnapShotAnimation(item.id, target);
      setSnapShotAnimationDestination(
        item.id,
        {
          isConnected: true,
          getBoundingClientRect: () => ({ x: 0, y: 0, width: 208, height: 112 }),
        } as HTMLElement,
        item.source,
      );

      const delivery = deliverSnapShot(bridge, item, target);
      await vi.advanceTimersByTimeAsync(0);

      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      expect(draft?.images).toHaveLength(1);
      expect(draft?.images[0]?.source).toEqual(item.source);
      expect(getPendingSnapShotAnimations()).toHaveLength(1);
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();

      expect(animationFrames).toHaveLength(1);
      animationFrames.shift()?.(0);
      animationFrames.shift()?.(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getPendingSnapShotAnimations()).toHaveLength(0);
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();
      expect(animationFrames).toHaveLength(1);
      animationFrames.shift()?.(0);
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();
      animationFrames.shift()?.(0);
      await delivery;
      expect(acknowledgeSnapShot).toHaveBeenCalledWith(item.id);
    },
  );
});

describe("window capture target resolution", () => {
  it("shares bare-route draft creation between animation start and capture drain", async () => {
    const draftId = DraftId.make("snap-shot-draft");
    let finishResolution: ((target: DraftId) => void) | undefined;
    const resolveTarget = vi.fn(
      () =>
        new Promise<DraftId>((resolve) => {
          finishResolution = resolve;
        }),
    );
    const resolutionRef: { current: Promise<DraftId | null> | null } = { current: null };

    const animationTarget = resolveSnapShotTargetOnce(resolutionRef, resolveTarget);
    const attachmentTarget = resolveSnapShotTargetOnce(resolutionRef, resolveTarget);

    expect(animationTarget).toBe(attachmentTarget);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    finishResolution?.(draftId);
    await expect(animationTarget).resolves.toBe(draftId);
    expect(resolutionRef.current).toBeNull();
  });

  it("follows a draft to its promoted server thread", () => {
    const draftId = DraftId.make("snap-shot-draft");
    const promotedRef = scopeThreadRef(environmentId, ThreadId.make("snap-shot-promoted-thread"));
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId: ThreadId.make("snap-shot-draft-thread"),
    });
    store.markDraftThreadPromoting(draftId, promotedRef);

    expect(resolveExistingSnapShotTarget(draftId, null)).toEqual(promotedRef);
  });

  it("keeps the routed server thread before its shell loads", () => {
    const routeThreadRef = scopeThreadRef(environmentId, ThreadId.make("snap-shot-routed-thread"));

    expect(resolveExistingSnapShotTarget(routeThreadRef, routeThreadRef)).toEqual(routeThreadRef);
  });
});

describe("durable snapshot delivery", () => {
  it.each([false, true])(
    "retains a capture on quota failure and retries without duplicates (staged: %s)",
    async (staged) => {
      const target = scopeThreadRef(environmentId, ThreadId.make("quota-thread"));
      const capture = {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "window.png",
        mimeType: "image/png" as const,
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,AQID",
        source: {
          kind: "snap-shot" as const,
          capturedAt: "2026-09-01T00:00:00.000Z",
          appName: "Editor",
          windowTitle: "main.ts",
        },
      };
      const acknowledgeSnapShot = vi.fn(async () => undefined);
      const bridge = {
        readSnapShot: async () => capture,
        acknowledgeSnapShot,
      } as unknown as DesktopSnapShotBridge;
      vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
      const write = storage.setItem.getMockImplementation()!;
      storage.setItem.mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      try {
        if (staged) {
          const store = useComposerDraftStore.getState();
          store.addImage(target, {
            type: "image",
            ...capture,
            previewUrl: capture.dataUrl,
            file: new File([new Uint8Array([1, 2, 3])], capture.name, { type: capture.mimeType }),
          });
          void store.syncPersistedAttachments(target, [capture]);
        }
        await expect(deliverSnapShot(bridge, capture, target)).rejects.toThrow(
          "could not be saved",
        );
        expect(acknowledgeSnapShot).not.toHaveBeenCalled();
        expect(
          useComposerDraftStore.getState().getComposerDraft(target)?.nonPersistedImageIds,
        ).toContain(capture.id);
        storage.setItem.mockImplementation(write);
        await deliverSnapShot(bridge, capture, target);
        expect(acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
        expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toHaveLength(1);
        expect(
          useComposerDraftStore.getState().getComposerDraft(target)?.persistedAttachments,
        ).toHaveLength(1);
      } finally {
        storage.setItem.mockImplementation(write);
      }
    },
  );
});

describe("snapshot destination ownership", () => {
  it.each(["unmount", "blur", "disabled animations"])(
    "keeps the original environment and thread after %s",
    async (reason) => {
      const original = scopeThreadRef(environmentId, ThreadId.make("original"));
      const next = scopeThreadRef(EnvironmentId.make("another-environment"), ThreadId.make("next"));
      const targets = new Map<string, Promise<typeof original | null>>();
      let current = original;
      const resolveTarget = async () => current;
      const requested = resolveSnapShotDeliveryTarget(targets, "capture", resolveTarget);
      if (reason !== "disabled animations") {
        beginSnapShotAnimation("capture", original);
        if (reason === "unmount") {
          const unmount = scheduleSnapShotAnimationDestination("capture", () => undefined);
          unmount();
        } else dismissAllSnapShotAnimations();
      }
      current = next;
      await requested;
      expect(getPendingSnapShotAnimations()).toHaveLength(0);
      expect(await resolveSnapShotDeliveryTarget(targets, "capture", resolveTarget)).toEqual(
        original,
      );
      expect(await resolveSnapShotDeliveryTarget(targets, "later-capture", resolveTarget)).toEqual(
        next,
      );
    },
  );
});
