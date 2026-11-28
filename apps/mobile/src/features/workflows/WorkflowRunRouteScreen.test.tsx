import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, workflowsLive } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  workflowsLive: vi.fn(),
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: vi.fn() }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../components/RelativeTime", () => ({ RelativeTime: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { workflowsLive } }));
vi.mock("../../state/session", () => ({ useEnvironmentSessionId: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./WorkflowStepCard", () => ({}));
vi.mock("./WorkflowsScreen", () => ({}));
vi.mock("./WorkflowTimeline", () => ({}));

import { WorkflowRunRouteScreen } from "./WorkflowRunRouteScreen";

it("handles a direct WorkflowRun route with a whitespace-only environment id", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <WorkflowRunRouteScreen route={{ params: { environmentId: " ", runId: "run-1" } }} />,
      ),
    );
    expect(container.textContent).toContain("Could not load the run");
    expect(workflowsLive).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
