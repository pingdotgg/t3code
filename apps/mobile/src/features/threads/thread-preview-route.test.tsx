import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { ThreadPreviewRoute, useCaptureThreadNavigation } from "./thread-preview-route";

const host = vi.hoisted(() => ({
  state: { threadId: "main" },
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext, use, useImperativeHandle, useState } = await import("react");
  const hostNavigation = {
    dispatch: () => undefined,
    isFocused: () => true,
    getState: () => host.state,
  };
  const Navigation = createContext(hostNavigation);
  return {
    useNavigation: () => use(Navigation),
    NavigationIndependentTree: ({ children }: { children: React.ReactNode }) => children,
    NavigationContainer: ({
      children,
      ref,
    }: {
      children: React.ReactNode;
      ref: React.Ref<unknown>;
    }) => {
      const [navigation] = useState(() => ({
        dispatch: () => undefined,
        isFocused: () => true,
        getState: () => state,
      }));
      const [state] = useState({ threadId: "inspector" });
      useImperativeHandle(ref, () => navigation, [navigation]);
      return <Navigation value={navigation}>{children}</Navigation>;
    },
    createNavigatorFactory: () => () => ({
      Navigator: ({ children }: { children: React.ReactNode }) => children,
      Screen: ({ children }: { children: (screen: { route: object }) => React.ReactNode }) =>
        children({ route: {} }),
    }),
  };
});

vi.mock("../../lib/useMobileNavigationTheme", () => ({
  useMobileNavigationTheme: () => undefined,
}));

it.each(["switch host thread", "close inspector", "change inspector target"] as const)(
  "leaves the workspace alone when a pending inspector fork finishes after %s",
  async (action) => {
    const testEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = testEnvironment.IS_REACT_ACT_ENVIRONMENT;
    testEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    host.state = { threadId: "main" };
    const root = createRoot(document.createElement("div"));
    const forkReady = Promise.withResolvers<void>();
    const openFork = vi.fn();
    let startFork!: () => Promise<void>;

    function ForkAction() {
      const captureNavigation = useCaptureThreadNavigation();
      useLayoutEffect(() => {
        startFork = async () => {
          const isCurrent = captureNavigation();
          await forkReady.promise;
          if (isCurrent()) openFork();
        };
      });
      return null;
    }

    const render = (threadId: string) => (
      <ThreadPreviewRoute environmentId="test" threadId={threadId}>
        {() => <ForkAction />}
      </ThreadPreviewRoute>
    );

    try {
      act(() => root.render(render("inspector")));
      const finished = startFork();
      act(() => {
        switch (action) {
          case "switch host thread":
            host.state = { threadId: "other" };
            break;
          case "close inspector":
            root.render(null);
            break;
          case "change inspector target":
            root.render(render("other-inspector"));
            break;
        }
      });
      forkReady.resolve();
      await finished;
      expect(openFork).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      testEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  },
);
