import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ClientSettings,
  type DesktopPendingSnapShot,
  type DesktopSnapShotEvent,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { DesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import * as settings from "../../hooks/useSettings";
import * as newThread from "../../hooks/useHandleNewThread";
import * as snapShotSound from "../../lib/snapShotSound";
import { toastManager } from "../ui/toast";
import * as imageCompression from "../../lib/imageCompression";
import {
  questionAttachmentDraftId,
  trackOpenQuestionAttachmentDraft,
} from "../../questionAttachments";
import {
  beginSnapShotAnimationWhenReady,
  deliverSnapShot,
  dismissFailedSnapShot,
  resolveExistingSnapShotTarget,
  resolveSnapShotAttachmentTarget,
  resolveSnapShotTargetOnce,
  resolveSnapShotDeliveryTarget,
  SnapShotCoordinator,
} from "./SnapShotCoordinator";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  getPendingSnapShotAnimations,
  setSnapShotAnimationDestination,
  scheduleSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";

vi.mock(import("../../hooks/useSettings"), { spy: true });
vi.mock(import("../../hooks/useHandleNewThread"), { spy: true });
vi.mock(import("../../lib/snapShotSound"), { spy: true });
vi.mock(import("../../lib/imageCompression"), { spy: true });

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
  vi.restoreAllMocks();
});

describe("window capture failures", () => {
  it("dismisses an older failed capture without disturbing a newer capture", async () => {
    const target = DraftId.make("snap-shot-draft");
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const dismissSnapShotAnimation = vi.fn(async () => undefined);
    vi.stubGlobal("desktopBridge", {
      requestSnapShotPermissions: vi.fn(),
      getSnapShotState: vi.fn(),
      checkSnapShotShortcut: vi.fn(),
      setSnapShotShortcutSuppressed: vi.fn(),
      listPendingSnapShots: vi.fn(),
      readSnapShot: vi.fn(),
      acknowledgeSnapShot: vi.fn(),
      onSnapShotEvent: vi.fn(() => () => undefined),
      dismissSnapShotAnimation,
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

describe("pending snapshot processing", () => {
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
  const target = scopeThreadRef(environmentId, ThreadId.make("enabled-thread"));
  let root: Root;
  let container: HTMLDivElement;

  function setup(routeThreadRef: typeof target | null = target) {
    let currentSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotPlaySound: true,
      snapShotAnimations: false,
    };
    const listeners = new Set<(event: DesktopSnapShotEvent) => void>();
    let pending = [capture];
    const bridge = {
      requestSnapShotPermissions: vi.fn(),
      getSnapShotState: vi.fn(),
      checkSnapShotShortcut: vi.fn(),
      setSnapShotShortcutSuppressed: vi.fn(),
      onSnapShotEvent: vi.fn((listener: (event: DesktopSnapShotEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      listPendingSnapShots: vi.fn(async () => pending),
      readSnapShot: vi.fn(async () => capture),
      acknowledgeSnapShot: vi.fn(async (id: string) => {
        pending = pending.filter((item) => item.id !== id);
      }),
    };
    vi.spyOn(settings, "getClientSettings").mockImplementation(() => currentSettings);
    vi.spyOn(settings, "useClientSettings").mockImplementation(
      <T = ClientSettings>(selector?: (value: ClientSettings) => T) =>
        selector ? selector(currentSettings) : (currentSettings as T),
    );
    const route = {
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: routeThreadRef ? projectRef : null,
      handleNewThread: vi.fn<ReturnType<typeof newThread.useHandleNewThread>["handleNewThread"]>(),
      routeDraftId: null,
      routeThreadRef,
    };
    vi.spyOn(newThread, "useHandleNewThread").mockImplementation(() => ({ ...route }));
    const sound = vi.spyOn(snapShotSound, "playSnapShotSound").mockImplementation(() => undefined);
    const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
    vi.stubGlobal("desktopBridge", bridge);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = () => act(async () => root.render(createElement(SnapShotCoordinator)));
    return {
      bridge,
      route,
      sound,
      toast,
      render,
      setPending: (items: typeof pending) => {
        pending = items;
      },
      setEnabled: async (snapShotEnabled: boolean) => {
        currentSettings = { ...currentSettings, snapShotEnabled };
        await render();
      },
      emit: (event: DesktopSnapShotEvent) =>
        act(async () => {
          for (const listener of listeners) listener(event);
        }),
    };
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  const focus = () =>
    act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

  it("leaves captures untouched while disabled and resumes them when enabled again", async () => {
    const fixture = setup();
    const { bridge, sound, toast } = fixture;
    await fixture.setEnabled(false);
    await focus();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(bridge.onSnapShotEvent).not.toHaveBeenCalled();
    expect(bridge.listPendingSnapShots).not.toHaveBeenCalled();
    expect(bridge.readSnapShot).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();

    await fixture.setEnabled(true);
    await vi.waitFor(() =>
      expect(bridge.acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toHaveLength(1);
    expect(sound).toHaveBeenCalledOnce();

    await fixture.setEnabled(false);
    const another = { ...capture, id: "another-capture" };
    fixture.setPending([another]);
    bridge.listPendingSnapShots.mockClear();
    await fixture.emit({ type: "started", id: another.id });
    await fixture.emit({ type: "ready", id: another.id });
    await fixture.emit({ type: "failed", id: another.id });
    await focus();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(bridge.listPendingSnapShots).not.toHaveBeenCalled();
    expect(bridge.getSnapShotState).not.toHaveBeenCalled();
    expect(bridge.readSnapShot).toHaveBeenCalledOnce();
    expect(sound).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it("reports each pending capture failure once, allows a new failure kind, and resets after success", async () => {
    const fixture = setup(null);
    const { bridge, sound, toast, route } = fixture;
    await fixture.render();
    await focus();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Snapshot taken, but no project is available",
      }),
    );
    expect(sound).toHaveBeenCalledOnce();
    expect(bridge.acknowledgeSnapShot).not.toHaveBeenCalled();

    route.routeThreadRef = target;
    bridge.readSnapShot.mockRejectedValue(new Error("Capture unavailable"));
    await fixture.render();
    await focus();
    await fixture.emit({ type: "ready", id: capture.id });
    expect(toast.mock.calls.map(([value]) => value.title)).toEqual([
      "Snapshot taken, but no project is available",
      "Snapshot failed",
    ]);
    expect(sound).toHaveBeenCalledOnce();
    expect(bridge.acknowledgeSnapShot).not.toHaveBeenCalled();

    route.routeThreadRef = null;
    await fixture.render();
    await focus();
    expect(toast).toHaveBeenCalledTimes(2);
    route.routeThreadRef = target;
    await fixture.render();

    bridge.readSnapShot.mockResolvedValue(capture);
    await focus();
    await vi.waitFor(() =>
      expect(bridge.acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toHaveLength(1);
    fixture.setPending([capture]);
    bridge.readSnapShot.mockRejectedValue(new Error("Capture unavailable again"));
    await focus();
    await focus();
    expect(sound).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls.map(([value]) => value.title)).toEqual([
      "Snapshot taken, but no project is available",
      "Snapshot failed",
      "Snapshot failed",
    ]);
  });

  it("suppresses deferred failures while disabled and reports fresh failures after re-enable", async () => {
    const fixture = setup();
    const { bridge, sound, toast } = fixture;
    let rejectRead: ((error: Error) => void) | undefined;
    bridge.readSnapShot.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
    );
    await fixture.render();
    expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
    await fixture.setEnabled(false);
    await act(async () => rejectRead?.(new Error("Capture unavailable")));
    expect(toast).not.toHaveBeenCalled();
    expect(bridge.acknowledgeSnapShot).not.toHaveBeenCalled();

    bridge.readSnapShot.mockRejectedValue(new Error("Capture unavailable"));
    await fixture.setEnabled(true);
    await focus();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ description: `Capture ${capture.id}: Capture unavailable` }),
    );
    expect(sound).toHaveBeenCalledOnce();

    await fixture.setEnabled(false);
    let rejectList: ((error: Error) => void) | undefined;
    bridge.listPendingSnapShots.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectList = reject;
      }),
    );
    await fixture.setEnabled(true);
    await fixture.setEnabled(false);
    await act(async () => rejectList?.(new Error("Pending captures unavailable")));
    expect(toast).toHaveBeenCalledOnce();

    bridge.listPendingSnapShots.mockRejectedValueOnce(new Error("Pending captures unavailable"));
    await fixture.setEnabled(true);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Pending captures unavailable" }),
    );

    fixture.setPending([]);
    let resolveState: ((state: { message: string }) => void) | undefined;
    bridge.getSnapShotState.mockReturnValueOnce(
      new Promise<{ message: string }>((resolve) => {
        resolveState = resolve;
      }),
    );
    await fixture.emit({ type: "failed", id: "native-capture" });
    expect(bridge.getSnapShotState).toHaveBeenCalledOnce();
    await fixture.setEnabled(false);
    await act(async () => resolveState?.({ message: "Native capture unavailable" }));
    expect(toast).toHaveBeenCalledTimes(2);

    bridge.getSnapShotState.mockResolvedValue({ message: "Native capture unavailable" });
    await fixture.setEnabled(true);
    await fixture.emit({ type: "failed", id: "native-capture" });
    expect(toast).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Native capture unavailable" }),
    );
    expect(sound).toHaveBeenCalledOnce();
    expect(bridge.acknowledgeSnapShot).not.toHaveBeenCalled();
  });

  it("keeps a capture pending when disabled during target resolution, then retries on re-enable", async () => {
    const fixture = setup(null);
    const { bridge, route } = fixture;
    route.defaultProjectRef = projectRef;
    const draftId = DraftId.make("resolving-snapshot");
    const threadId = ThreadId.make("resolving-snapshot-thread");
    let resolveTarget: ((target: { draftId: DraftId; threadId: ThreadId }) => void) | undefined;
    const resolution = new Promise<{ draftId: DraftId; threadId: ThreadId }>((resolve) => {
      resolveTarget = resolve;
    });
    route.handleNewThread.mockReturnValue(resolution);
    await fixture.render();
    expect(route.handleNewThread).toHaveBeenCalledOnce();
    await fixture.setEnabled(false);
    await act(async () => {
      useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, { threadId });
      resolveTarget?.({ draftId, threadId });
    });
    expect(bridge.readSnapShot).not.toHaveBeenCalled();
    expect(bridge.acknowledgeSnapShot).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.images ?? []).toEqual([]);
    await fixture.setEnabled(true);
    await vi.waitFor(() =>
      expect(bridge.acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.images).toHaveLength(1);
  });

  it("finishes and acknowledges delivery already reading when disabled", async () => {
    const fixture = setup();
    let finishReading: ((value: typeof capture) => void) | undefined;
    const reading = new Promise<typeof capture>((resolve) => {
      finishReading = resolve;
    });
    fixture.bridge.readSnapShot.mockReturnValue(reading);
    await fixture.render();
    expect(fixture.bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
    await fixture.setEnabled(false);
    await act(async () => {
      finishReading?.(capture);
    });
    await vi.waitFor(() =>
      expect(fixture.bridge.acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toHaveLength(1);
    expect(fixture.toast).not.toHaveBeenCalled();
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
      vi.stubGlobal("desktopBridge", bridge);
      vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        backgroundColor: "rgb(0, 0, 0)",
        borderTopColor: "rgb(255, 255, 255)",
        borderTopLeftRadius: "8px",
        borderTopWidth: "1px",
      } as CSSStyleDeclaration);
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

      const persisted = new Promise<void>((resolve) => {
        const unsubscribe = useComposerDraftStore.subscribe((state) => {
          if (state.getComposerDraft(target)?.persistedAttachments.length) {
            unsubscribe();
            resolve();
          }
        });
      });
      const delivery = deliverSnapShot(bridge, item, () => target);
      await persisted;
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

describe("open question delivery", () => {
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("question-thread"));
  const first = questionAttachmentDraftId(environmentId, threadRef.threadId, "request-1", "q1");
  const second = questionAttachmentDraftId(environmentId, threadRef.threadId, "request-1", "q2");
  const request = { draftId: first, requestKeys: [first, second] };
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
  const makeBridge = (readSnapShot: () => Promise<typeof capture> = async () => capture) => {
    const acknowledgeSnapShot = vi.fn(async () => undefined);
    const bridge = { readSnapShot, acknowledgeSnapShot } as unknown as DesktopSnapShotBridge;
    return { bridge, acknowledgeSnapShot };
  };

  it("attaches a capture to the open question draft and leaves the thread draft alone", async () => {
    const pins = new Map();
    const untrack = trackOpenQuestionAttachmentDraft(threadRef, request);
    try {
      const { bridge, acknowledgeSnapShot } = makeBridge();
      await deliverSnapShot(bridge, capture, () =>
        resolveSnapShotAttachmentTarget(pins, capture.id, threadRef),
      );
      const store = useComposerDraftStore.getState();
      expect(store.getComposerDraft(first)?.images.map(({ id }) => id)).toEqual([capture.id]);
      expect(store.getComposerDraft(threadRef)?.images ?? []).toHaveLength(0);
      expect(acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
    } finally {
      untrack();
    }
  });

  it("falls back to the thread when a newer question replaces the pinned one during compression", async () => {
    const pins = new Map();
    const untrackFirst = trackOpenQuestionAttachmentDraft(threadRef, request);
    let untrackSecond = () => {};
    const compression = vi
      .spyOn(imageCompression, "compressImageToByteLimit")
      .mockImplementationOnce(async (file) => {
        untrackSecond = trackOpenQuestionAttachmentDraft(threadRef, {
          ...request,
          draftId: second,
        });
        untrackFirst();
        return { ok: true, file, recompressed: false };
      });
    try {
      const { bridge, acknowledgeSnapShot } = makeBridge();
      const resolveTarget = () => resolveSnapShotAttachmentTarget(pins, capture.id, threadRef);
      expect(resolveTarget()).toBe(first);
      await deliverSnapShot(bridge, capture, resolveTarget);
      const store = useComposerDraftStore.getState();
      expect(store.getComposerDraft(first)?.images ?? []).toHaveLength(0);
      expect(store.getComposerDraft(second)?.images ?? []).toHaveLength(0);
      expect(store.getComposerDraft(threadRef)?.images.map(({ id }) => id)).toEqual([capture.id]);
      expect(acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
    } finally {
      compression.mockRestore();
      untrackFirst();
      untrackSecond();
    }
  });

  it("keeps a capture pinned before any question off a question that opens during the read", async () => {
    const pins = new Map();
    const resolveTarget = () => resolveSnapShotAttachmentTarget(pins, capture.id, threadRef);
    // The drain pins a capture it never saw requested before reading it.
    expect(resolveTarget()).toEqual(threadRef);
    let untrack = () => {};
    const { bridge, acknowledgeSnapShot } = makeBridge(async () => {
      untrack = trackOpenQuestionAttachmentDraft(threadRef, request);
      return capture;
    });
    try {
      await deliverSnapShot(bridge, capture, resolveTarget);
      const store = useComposerDraftStore.getState();
      expect(store.getComposerDraft(first)?.images ?? []).toHaveLength(0);
      expect(store.getComposerDraft(threadRef)?.images.map(({ id }) => id)).toEqual([capture.id]);
      expect(acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
    } finally {
      untrack();
    }
  });

  it("refuses a capture once the request's other questions hold the shared limit", async () => {
    useComposerDraftStore.getState().addImages(
      first,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
        type: "image" as const,
        id: `staged-${index}`,
        name: `staged-${index}.png`,
        mimeType: "image/png",
        sizeBytes: 3,
        previewUrl: `data:image/png;base64,AQID${index}`,
        file: new File([new Uint8Array([1, 2, 3])], `staged-${index}.png`, { type: "image/png" }),
      })),
    );
    const untrack = trackOpenQuestionAttachmentDraft(threadRef, { ...request, draftId: second });
    try {
      const { bridge, acknowledgeSnapShot } = makeBridge();
      await expect(deliverSnapShot(bridge, capture, () => second)).rejects.toThrow(
        "Remove an attachment",
      );
      expect(useComposerDraftStore.getState().getComposerDraft(second)?.images ?? []).toHaveLength(
        0,
      );
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();
    } finally {
      untrack();
    }
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
        await expect(deliverSnapShot(bridge, capture, () => target)).rejects.toThrow(
          "could not be saved",
        );
        expect(acknowledgeSnapShot).not.toHaveBeenCalled();
        expect(
          useComposerDraftStore.getState().getComposerDraft(target)?.nonPersistedImageIds,
        ).toContain(capture.id);
        storage.setItem.mockImplementation(write);
        await deliverSnapShot(bridge, capture, () => target);
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
