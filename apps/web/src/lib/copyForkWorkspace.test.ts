import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { copyForkWorkspace } from "./copyForkWorkspace";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits for saved browser tabs to load when forking before preview hydration", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const environmentId = EnvironmentId.make("local");
  const source = scopeThreadRef(environmentId, ThreadId.make("hydrating-source"));
  const target = scopeThreadRef(environmentId, ThreadId.make("fork-target"));
  const pending = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const snapshot: PreviewSessionSnapshot = {
    threadId: source.threadId,
    tabId: "saved-tab",
    navStatus: { _tag: "Success", title: "Guide", url: "https://example.com/guide" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  vi.spyOn(previewEnvironment, "list").mockReturnValue(
    Atom.make(
      Effect.promise(async () => {
        requested.resolve();
        await pending.promise;
        return { sessions: [snapshot], revision: 1, serverEpoch: "test" };
      }),
    ),
  );
  const panels = useRightPanelStore.getState();
  panels.openBrowser(source, snapshot.tabId);
  panels.openFile(source, "README.md");
  const open = vi.fn(async () =>
    AsyncResult.success({ ...snapshot, threadId: target.threadId, tabId: "new-tab" }),
  );
  const copy = copyForkWorkspace(source, target, open);
  await requested.promise;
  expect(open).not.toHaveBeenCalled();
  pending.resolve();
  await copy;
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        threadId: target.threadId,
        url: "https://example.com/guide",
      }),
    }),
  );
});
