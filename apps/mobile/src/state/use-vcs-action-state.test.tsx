import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Error: "error" },
  notificationAsync: mocks.notificationAsync,
}));

vi.mock("./vcs", async () => {
  const { Atom } = await import("effect/reactivity");
  const idle = Atom.make({ isRunning: false });
  return { vcsActionManager: { stateAtom: () => idle } };
});

import { appAtomRegistry } from "./atom-registry";
import {
  dismissGitActionResult,
  showGitActionResult,
  useGitActionProgress,
} from "./use-vcs-action-state";

const owner = { environmentId: EnvironmentId.make("first"), threadId: ThreadId.make("thread-a") };
const otherThread = { ...owner, threadId: ThreadId.make("thread-b") };

function mountGitBanner() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);

  function Banner({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
    const progress = useGitActionProgress(
      { environmentId: threadRef?.environmentId ?? null, cwd: "/repo" },
      threadRef,
    );
    return progress.label;
  }

  return {
    select(threadRef: ScopedThreadRef | null) {
      act(() => {
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <Banner threadRef={threadRef} />
          </RegistryContext.Provider>,
        );
      });
    },
    get text() {
      return container.textContent;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("showGitActionResult", () => {
  it("buzzes once per reported result with the matching feedback type", () => {
    showGitActionResult({ threadRef: owner, type: "success", title: "Pushed" });
    showGitActionResult({
      threadRef: owner,
      type: "error",
      title: "Git action failed",
      description: "rejected",
    });
    dismissGitActionResult(owner);

    expect(mocks.notificationAsync.mock.calls).toEqual([["success"], ["error"]]);
  });
});

describe("thread Git result banners", () => {
  it.each([
    { name: "another thread", resultOwner: owner, viewer: otherThread },
    {
      name: "the same thread ID in another environment",
      resultOwner: owner,
      viewer: { ...owner, environmentId: EnvironmentId.make("second") },
    },
    {
      name: "a thread whose IDs join to the same string",
      resultOwner: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("a:b") },
      viewer: { environmentId: EnvironmentId.make("env:a"), threadId: ThreadId.make("b") },
    },
    { name: "no selected thread", resultOwner: owner, viewer: null },
  ])("hides a thread's result from $name", ({ resultOwner, viewer }) => {
    try {
      showGitActionResult({ threadRef: resultOwner, type: "success", title: "Pulled" });
      using banner = mountGitBanner();
      banner.select(resultOwner);
      expect(banner.text).toBe("Pulled");
      banner.select(viewer);
      expect(banner.text).toBe("");
    } finally {
      dismissGitActionResult(resultOwner);
    }
  });

  it("keeps each thread's result when another thread reports or dismisses", () => {
    try {
      using banner = mountGitBanner();
      showGitActionResult({ threadRef: otherThread, type: "error", title: "Rejected" });
      banner.select(otherThread);
      act(() => showGitActionResult({ threadRef: owner, type: "success", title: "Pulled" }));
      expect(banner.text).toBe("Rejected");
      act(() => dismissGitActionResult(otherThread));
      expect(banner.text).toBe("");
      banner.select(owner);
      expect(banner.text).toBe("Pulled");
    } finally {
      dismissGitActionResult(owner);
      dismissGitActionResult(otherThread);
    }
  });
});
