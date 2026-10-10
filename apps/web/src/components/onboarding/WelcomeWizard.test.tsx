// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import type { AppRouter } from "../../router";
import type { LanguagePreference } from "@t3tools/client-runtime/i18n";
import { AppRoot } from "../../AppRoot";
import { changeLanguage } from "../../i18n";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  connectionPhase: "connected" as EnvironmentConnectionPresentation["phase"],
  languagePreference: "en" as LanguagePreference,
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (
    selector: (settings: { languagePreference: LanguagePreference }) => unknown,
  ) => selector(mocks),
  useClientSettingsHydrated: () => true,
}));
vi.mock("../../rpc/atomRegistry", () => ({
  AppAtomRegistryProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../../browser/BrowserProfileReporter", () => ({ BrowserProfileReporter: () => null }));
vi.mock("../QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: {
      get phase() {
        return mocks.connectionPhase;
      },
    },
    entry: { enabled: true },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.languagePreference = "en";
  await changeLanguage("en");
  mocks.connectionPhase = "connected";
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 28, skippedCount: 1 },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await changeLanguage("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the real welcome wizard translated across route and preference changes", async () => {
  const rootRoute = createRootRoute({ component: Outlet });
  const welcomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/welcome",
    component: () => <WelcomeWizard localAvailable onDone={vi.fn()} />,
  });
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <main>Workspace</main>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([welcomeRoute, shellRoute]),
    history: createMemoryHistory({ initialEntries: ["/welcome"] }),
  });
  await router.load();
  // The test route tree deliberately omits unrelated app routes and their I/O.
  const appRouter = router as unknown as AppRouter;
  const renderApp = () => act(async () => root.render(<AppRoot router={appRouter} />));
  await renderApp();
  expect(document.body.textContent).toContain("Connect your computers");
  await act(async () => {
    await router.navigate({ to: "/" });
  });
  expect(container.textContent).toContain("Workspace");
  mocks.languagePreference = "zh";
  await renderApp();
  expect(document.documentElement.lang).toBe("zh");
  await act(async () => {
    await router.navigate({ to: "/welcome" });
  });
  expect(document.body.textContent).toContain("连接你的电脑");
  expect(document.body.textContent).toContain("继续");
  expect(document.querySelector('ol[aria-label="设置进度"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label="连接，第 1 步"]')).not.toBeNull();
  await act(async () => {
    await router.navigate({ to: "/" });
  });
  mocks.languagePreference = "en";
  await renderApp();
  await act(async () => {
    await router.navigate({ to: "/welcome" });
  });
  expect(document.body.textContent).toContain("Connect your computers");
  expect(document.body.textContent).not.toContain("连接你的电脑");
  expect(document.documentElement.lang).toBe("en");
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

it.each([
  ["connected", "Connected"],
  ["connecting", "Connecting…"],
  ["reconnecting", "Reconnecting…"],
  ["unsupported", "Client not supported"],
  ["error", "Connection failed"],
  ["offline", "Offline"],
  ["available", "Not connected"],
] as const)("shows the actual %s connection state", async (phase, label) => {
  mocks.connectionPhase = phase;
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  const computer = document.querySelector("fieldset label");
  expect(computer?.textContent).toContain(label);
  if (phase !== "connecting") {
    expect(computer?.textContent).not.toContain("Connecting…");
  }
});

it("enters the workspace after a partial import and warns after navigation finishes", async () => {
  let finishNavigation = () => {};
  const navigation = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });
  const onDone = vi.fn(() => navigation);
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    projectId: ProjectId.make("test-project"),
  });
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => finishNavigation());
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
  expect(mocks.toast.mock.invocationCallOrder[0]).toBeGreaterThan(
    onDone.mock.invocationCallOrder[0]!,
  );
});

it.each([
  [0, 0, null],
  [29, 0, null],
  [1, 0, null],
  [0, 1, "1 thread could not be imported."],
  [0, 2, "2 threads could not be imported."],
] as const)(
  "finishes setup with %i imported and %i skipped threads",
  async (importedCount, skippedCount, warning) => {
    mocks.importThreads.mockResolvedValue({
      _tag: "Success",
      value: { importedCount, skippedCount },
    });
    const onDone = vi.fn();
    await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
    await click("Continue");
    await click("Continue");
    await click("Import 1 project");
    expect(onDone).toHaveBeenCalledOnce();
    if (warning === null && importedCount > 0) {
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: `Imported ${importedCount} ${importedCount === 1 ? "thread" : "threads"}`,
      });
    } else if (warning === null) {
      expect(mocks.toast).not.toHaveBeenCalled();
    } else {
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", description: warning }),
      );
    }
  },
);

it("keeps setup open when saving completion fails and preserves the import warning on retry", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Do not import projects");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.importThreads).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
});
