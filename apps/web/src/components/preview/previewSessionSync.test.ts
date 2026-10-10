import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Only the transport is substituted. The hook, atom registry and preview
// store run unchanged, including lazy evaluation and refresh notifications.
type ListResult = AsyncResult.AsyncResult<PreviewListResult, never>;
type EventResult = AsyncResult.AsyncResult<PreviewEvent, never>;
const harness = vi.hoisted(() => ({
  lists: new Map<
    string,
    {
      box: { current: ListResult; requests: number };
      atom: Atom.Writable<ListResult>;
    }
  >(),
  events: new Map<string, Atom.Writable<EventResult>>(),
}));

vi.mock("~/state/preview", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  return {
    previewEnvironment: {
      list: (target: { input: { threadId: string } }) => {
        const key = target.input.threadId;
        let entry = harness.lists.get(key);
        if (!entry) {
          const box: { current: ListResult; requests: number } = {
            current: AsyncResult.initial(),
            requests: 0,
          };
          const atom = Atom.writable(
            () => {
              box.requests += 1;
              return AsyncResult.waiting(box.current);
            },
            (ctx, value: ListResult) => {
              box.current = value;
              ctx.setSelf(value);
            },
          );
          entry = { box, atom };
          harness.lists.set(key, entry);
        }
        return entry.atom;
      },
      events: (target: { environmentId: string }) => {
        let atom = harness.events.get(target.environmentId);
        if (!atom) {
          atom = Atom.make<EventResult>(AsyncResult.initial());
          harness.events.set(target.environmentId, atom);
        }
        return atom;
      },
    },
  };
});

import {
  applyPreviewServerSnapshot,
  applyPreviewDesktopState,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { usePreviewSession } from "./usePreviewSession";

let renderer: ReactTestRenderer | null = null;
let sequence = 0;
let ref: ScopedThreadRef;

function SessionSync() {
  usePreviewSession(ref);
  return null;
}

const listAtom = () => {
  previewEnvironment.list({ environmentId: ref.environmentId, input: { threadId: ref.threadId } });
  return harness.lists.get(ref.threadId)!.atom;
};
const result = (
  revision: number,
  tabIds: string[],
  serverEpoch = "epoch-1",
): PreviewListResult => ({
  serverEpoch,
  revision,
  sessions: tabIds.map((tabId) => ({
    threadId: ref.threadId,
    tabId,
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-02T00:00:00.000Z",
  })),
});

async function mount() {
  await act(async () => {
    renderer = create(createElement(AppAtomRegistryProvider, null, createElement(SessionSync)));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sequence += 1;
  ref = {
    environmentId: EnvironmentId.make(`preview-sync-${sequence}`),
    threadId: ThreadId.make(`thread-sync-${sequence}`),
  };
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});

describe("native preview session synchronization", () => {
  it("evaluates the lazy list once and restores sessions that predate mounting", async () => {
    const atom = listAtom();
    await mount();
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(1);
    appAtomRegistry.set(atom, AsyncResult.success(result(1, ["restored"])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("restored");
  });

  it("preserves a local tab while cached absence is waiting for a fresh response", async () => {
    const atom = listAtom();
    appAtomRegistry.set(atom, AsyncResult.waiting(AsyncResult.success(result(1, []))));
    applyPreviewServerSnapshot(ref, result(1, ["local"]).sessions[0]!);
    await mount();
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(0);
    appAtomRegistry.set(atom, AsyncResult.success(result(2, ["local"])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    appAtomRegistry.set(atom, AsyncResult.success(result(3, [])));
    expect(readThreadPreviewState(ref).activeTabId).toBeNull();
  });

  it("refreshes a completed cache without treating its old absence as authoritative", async () => {
    const atom = listAtom();
    appAtomRegistry.set(atom, AsyncResult.success(result(1, [])));
    reconcilePreviewServerSessions(ref, result(1, []));
    applyPreviewServerSnapshot(ref, result(1, ["local"]).sessions[0]!);
    applyPreviewDesktopState(ref, "local", {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1.5,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "human",
      favicon: null,
    });
    await mount();
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(1);
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    expect(readThreadPreviewState(ref).desktopOverlay?.zoomFactor).toBe(1.5);
    appAtomRegistry.set(atom, AsyncResult.success(result(2, ["local"])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    expect(readThreadPreviewState(ref).desktopOverlay?.canGoBack).toBe(true);
  });

  it("retains newer event state when an older list response completes", async () => {
    const atom = listAtom();
    await mount();
    const snapshot = result(2, ["opened"]).sessions[0]!;
    previewEnvironment.events({ environmentId: ref.environmentId, input: {} });
    appAtomRegistry.set(
      harness.events.get(ref.environmentId)!,
      AsyncResult.success({
        type: "opened",
        threadId: ref.threadId,
        tabId: snapshot.tabId,
        snapshot,
        serverEpoch: "epoch-1",
        revision: 2,
        createdAt: snapshot.updatedAt,
      }),
    );
    appAtomRegistry.set(atom, AsyncResult.success(result(1, [])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("opened");
    expect(readThreadPreviewState(ref).serverRevision).toBe(2);
  });

  it("keeps the local snapshot on a completed failure and reconciles a later success", async () => {
    const atom = listAtom();
    applyPreviewServerSnapshot(ref, result(1, ["local"]).sessions[0]!);
    await mount();
    appAtomRegistry.set(atom, AsyncResult.failure(Cause.die("offline")));
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    appAtomRegistry.set(atom, AsyncResult.success(result(2, [])));
    expect(readThreadPreviewState(ref).activeTabId).toBeNull();
  });
});
