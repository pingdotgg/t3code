import type { ReactNode } from "react";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

interface Snapshot {
  readonly projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly workspaceRoot: string;
  }>;
  readonly catalog: {
    readonly isLoadingConnections: boolean;
    readonly hasLoadedShellSnapshot: boolean;
    readonly hasConnectingEnvironment: boolean;
    readonly connectionError: string | null;
  };
}

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: { snapshot: Snapshot | null } = { snapshot: null };
  return {
    state,
    set(next: Snapshot) {
      state.snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    route: { key: "thread-route", name: "Thread", params: {} as object },
    reset: () => undefined,
    checkout: vi.fn(),
    draftProjectRefs: [] as unknown[],
    // Hook results stay stable across renders, as the real hooks' are. Only
    // main's screen reads these (see the main-comparison mocks below).
    layout: { deferThreadSelectionUntil: () => undefined },
    navigation: { goBack: () => undefined },
    preventContext: { preventedRoutes: {} },
  };
});

function useSnapshot(): Snapshot {
  return useSyncExternalStore(harness.subscribe, () => harness.state.snapshot!);
}

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("./ThreadScreenHost", () => ({
  ThreadScreenFallback: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./NewTaskDraftScreen", () => ({
  NewTaskDraftScreen: (props: { initialProjectRef: { branch?: string | null } }) => {
    harness.draftProjectRefs.push(props.initialProjectRef);
    return <p>draft on {props.initialProjectRef.branch}</p>;
  },
}));
vi.mock("./new-task-context-presentation", () => ({
  resolveNewTaskBranchWorktreePath: () => null,
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => harness,
}));
vi.mock("./checkout-new-task-branch", () => ({ checkoutNewTaskBranch: harness.checkout }));
// Main-comparison mocks: this screen no longer uses them, but main's screen
// did (deferThreadSelectionUntil, useAtomCommand, useNavigation). They stay so
// this test can run against main's screen and fail there for the right reason
// (a second checkout) instead of on an unmockable import.
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => harness.layout,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.checkout }));
vi.mock("../../state/entities", () => ({ useProjects: () => useSnapshot().projects }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: useSnapshot().catalog }),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { readRefs: {}, switchRef: {} } }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { goBack: () => ({ type: "GO_BACK" }) },
  createNavigationContainerRef: () => ({ current: null }),
  // Main-comparison only, like the mocks above.
  useNavigation: () => harness.navigation,
  useRoute: () => harness.route,
  usePreventRemove: () => undefined,
  usePreventRemoveContext: () => harness.preventContext,
}));

import { NewTaskDraftRouteScreen } from "./NewTaskDraftRouteScreen";

const project = { environmentId: "env-1", id: "project-1", workspaceRoot: "/repo" };
const connected: Snapshot["catalog"] = {
  isLoadingConnections: false,
  hasLoadedShellSnapshot: true,
  hasConnectingEnvironment: false,
  connectionError: null,
};

// The project can vanish while the catalog still loads, or while it reports ready.
it.each([
  ["while the catalog reloads", { ...connected, isLoadingConnections: true }],
  ["while the catalog stays ready", connected],
])(
  "checks the branch out once when a reconnect drops and restores the project %s",
  async (gap, gapCatalog) => {
    // Checkouts live in a module table keyed by route, so each case uses its own route.
    const routeKey = `thread-route ${gap}`;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const firstCheckout = Promise.withResolvers<unknown>();
    harness.checkout.mockReturnValueOnce(firstCheckout.promise);
    harness.checkout.mockResolvedValue(
      AsyncResult.success({ name: "feature", current: true, isDefault: false, worktreePath: null }),
    );
    harness.set({ projects: [project], catalog: connected });
    const draft = { environmentId: "env-1", projectId: "project-1", branch: "feature" };
    harness.route = { key: routeKey, name: "Thread", params: { draft } };

    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <NewTaskDraftRouteScreen
          route={{ key: routeKey, name: "Thread", params: draft } as never}
        />,
      ),
    );
    await vi.waitFor(() => expect(harness.checkout).toHaveBeenCalledTimes(1));

    // The connection drops while the checkout runs, then the project comes back.
    act(() => harness.set({ projects: [], catalog: gapCatalog }));
    act(() => harness.set({ projects: [project], catalog: connected }));
    await act(async () => {
      firstCheckout.resolve(
        AsyncResult.success({
          name: "feature",
          current: true,
          isDefault: false,
          worktreePath: null,
        }),
      );
    });

    await vi.waitFor(() =>
      expect(
        harness.checkout.mock.calls.length > 1 || container.textContent === "draft on feature",
      ).toBe(true),
    );
    expect(harness.checkout).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("draft on feature");
  },
);

it("hands the draft screen the same project ref across re-renders", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.checkout.mockReset();
  harness.draftProjectRefs.length = 0;
  harness.checkout.mockResolvedValue(
    AsyncResult.success({ name: "other", current: true, isDefault: false, worktreePath: null }),
  );
  harness.set({ projects: [project], catalog: connected });
  const draft = { environmentId: "env-1", projectId: "project-1", branch: "other" };
  harness.route = { key: "stable-route", name: "Thread", params: { draft } };

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <NewTaskDraftRouteScreen
        route={{ key: "stable-route", name: "Thread", params: draft } as never}
      />,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toBe("draft on other"));

  // The draft screen re-applies its route project when this identity changes,
  // and that write re-renders the route; an unstable ref loops forever.
  act(() => harness.set({ projects: [{ ...project }], catalog: { ...connected } }));
  // A stable ref lets the compiled screen skip re-rendering the draft screen at all; an unstable
  // one re-renders it with a second ref.
  expect(new Set(harness.draftProjectRefs).size).toBe(1);
});
