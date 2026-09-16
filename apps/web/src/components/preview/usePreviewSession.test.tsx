import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { create } from "react-test-renderer";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { PreviewListResult, ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  previewStateAtom,
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { usePreviewSession } from "./usePreviewSession";

vi.mock("~/state/preview", () => ({
  previewEnvironment: { list: () => sessionsAtom, events: () => eventsAtom },
}));
const ref = { environmentId: "local", threadId: "design-thread" } as ScopedThreadRef;
const saved: PreviewListResult = {
  serverEpoch: "server",
  revision: 1,
  sessions: [
    {
      threadId: ref.threadId,
      tabId: "design-tab",
      navStatus: {
        _tag: "Loading",
        title: "Design",
        url: "http://localhost/api/assets/design?t3-design=1&t3-design-path=.t3/designs/thread.html",
      },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-09-15T00:00:00Z",
    },
  ],
};
const sessionsAtom = Atom.make(AsyncResult.success(saved));
const eventsAtom = Atom.make(AsyncResult.initial());
function Host() {
  usePreviewSession(ref);
  return null;
}

afterEach(() => {
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "restores designs without discarding a locally opened tab (local: %s)",
  async (hasLocal) => {
    const registry = AtomRegistry.make();
    registry.set(sessionsAtom, AsyncResult.success(hasLocal ? { ...saved, sessions: [] } : saved));
    if (hasLocal) applyPreviewServerSnapshot(ref, saved.sessions[0]!);
    const observed: number[] = [];
    const unsubscribe = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(ref)), (state) =>
      observed.push(Object.keys(state.sessions).length),
    );
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(() => {
        renderer = create(
          <RegistryContext.Provider value={registry}>
            <Host />
          </RegistryContext.Provider>,
        );
      });
      expect(readThreadPreviewState(ref).sessions["design-tab"]).toEqual(saved.sessions[0]);
      if (hasLocal) expect(observed).not.toContain(0);
    } finally {
      await act(() => renderer?.unmount());
      unsubscribe();
      registry.dispose();
    }
  },
);
