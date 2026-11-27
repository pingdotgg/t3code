import {
  EnvironmentId,
  RunId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { AssistantForkButton } from "./AssistantForkButton";
import { ThreadPreviewRoute } from "./thread-preview-route";

const host = vi.hoisted(() => ({
  state: { threadId: "main" },
  fork: vi.fn(),
  openFork: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    disabled: boolean;
  }) => (
    <button type="button" onClick={onPress} aria-label={accessibilityLabel} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("gt-react-native", () => ({ useGT: () => (text: string) => text }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "forked-thread" }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { forkFromRun: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => host.fork }));
vi.mock("../../state/v2-item-support", () => ({
  useV2ItemSupport: () => ({ providerSession: undefined }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => host.openFork,
}));
vi.mock("./threadForkNavigation", () => ({ waitForThreadShell: async () => true }));

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

it.each([
  { action: "keep inspector open", opensFork: true },
  { action: "switch host thread", opensFork: false },
  { action: "close inspector", opensFork: false },
  { action: "change inspector target", opensFork: false },
] as const)("finishes an inspector fork after $action", async ({ action, opensFork }) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host.state = { threadId: "main" };
  const container = document.createElement("div");
  const root = createRoot(container);
  const forkReady = Promise.withResolvers<{ _tag: "Success" }>();
  host.fork.mockReset().mockReturnValue(forkReady.promise);
  host.openFork.mockClear();

  const render = (threadId: string) => (
    <ThreadPreviewRoute environmentId="test" threadId={threadId}>
      {() => (
        <AssistantForkButton
          environmentId={EnvironmentId.make("test")}
          iconColor="white"
          buttonSize={24}
          iconSize={16}
          projectedItem={
            {
              sourceThreadId: ThreadId.make(threadId),
              item: { type: "assistant_message", runId: RunId.make("run"), status: "completed" },
            } as OrchestrationV2ProjectedTurnItem
          }
          sourceTitle="Inspector"
        />
      )}
    </ThreadPreviewRoute>
  );

  try {
    act(() => root.render(render("inspector")));
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork from this response"]',
    )!;
    act(() => button.click());
    expect(host.fork).toHaveBeenCalledOnce();
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
    await act(async () => {
      forkReady.resolve({ _tag: "Success" });
    });
    expect(host.openFork.mock.calls).toEqual(
      opensFork
        ? [[{ name: "Thread", params: { environmentId: "test", threadId: "forked-thread" } }]]
        : [],
    );
  } finally {
    act(() => root.unmount());
  }
});
