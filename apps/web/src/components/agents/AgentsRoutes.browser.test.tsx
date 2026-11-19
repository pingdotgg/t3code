import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { useSidebar } from "../ui/sidebar";
const route = vi.hoisted(() => ({ pathname: "/agents", navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) => select(route),
  useNavigate: () => route.navigate,
  useParams: () => ({}),
  createFileRoute: () => (options: unknown) => options,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock("../../hooks/useThreadVisitedMigration", () => ({ useThreadVisitedMigration: () => {} }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {}, serverEnvironment: {} }));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  return {
    useLegacySidebarEnabled: () => false,
    useEnvironmentIdentificationMode: () => "none",
    useClientSettings: <T,>(select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  };
});
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShell: () => ({}),
  useThreadDetail: () => ({}),
  useThreadStatus: () => "ready",
  useQuietThreadShell: () => null,
  useQuietThreadShells: () => [],
}));
vi.mock("../../panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelNavigationSuppression: () => false,
  PanelAnimationSuppressionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../useCheckForUpdates", () => ({ useCheckForUpdates: () => async () => [] }));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  resolveSidebarStageFocusRingOffsetClass: () => "",
}));
vi.mock("../Sidebar", () => ({ default: () => <div>Thread navigation</div> }));
vi.mock("../LegacySidebar", () => ({ default: () => <div>Legacy navigation</div> }));
vi.mock("../settings/SettingsSidebarNav", () => ({
  SettingsSidebarNav: () => <div>Settings navigation</div>,
}));
vi.mock("../sidebar/SidebarChrome", () => ({
  SidebarBrandWidthProbe: () => null,
  SidebarChromeHeader: () => null,
}));
vi.mock("../ChatView", () => ({
  default: ({ showBackToAgents }: { showBackToAgents?: boolean }) => {
    const sidebar = useSidebar();
    return (
      <div>
        {showBackToAgents && <a href="/agents">Back to agents</a>}
        <label>
          Message
          <textarea />
        </label>
        <button onClick={() => sidebar.toggleSidebar()}>Toggle context</button>
        <span>{sidebar.open ? "context open" : "context closed"}</span>
      </div>
    );
  },
}));
import { AppSidebarLayout } from "../AppSidebarLayout";
import { AgentsThreadView } from "../../routes/agents.$environmentId.$threadId";

// The open state persists across cases and files, so a toggle here would carry over.
function persistedSidebarStateReset() {
  localStorage.removeItem("chat_thread_sidebar_open");
  return { [Symbol.dispose]: () => localStorage.removeItem("chat_thread_sidebar_open") };
}

describe("Agents route shell", () => {
  it.each(["/agents", "/agents/machine/thread"])(
    "hides navigation on %s and keeps chat's sidebar context usable",
    async (pathname) => {
      // Below the mobile breakpoint the sidebar is a sheet, not the layout under test.
      await page.viewport(1280, 900);
      using _sidebarState = persistedSidebarStateReset();
      route.pathname = pathname;
      await using screen = await render(
        <AppSidebarLayout>
          <AgentsThreadView environmentId="machine" threadId="thread" />
        </AppSidebarLayout>,
        { router: false },
      );
      const { container } = screen;
      expect(container.querySelector("[data-app-sidebar]")).toBeNull();
      expect(container.querySelector("[data-sidebar-control]")).toBeNull();
      expect(container.textContent).not.toContain("Thread navigation");
      expect(container.querySelector("textarea")).not.toBeNull();
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Toggle context")!
          .click(),
      );
      expect(container.textContent).toContain("context closed");
    },
  );
  it("restores the regular sidebar when leaving agents", async () => {
    await page.viewport(1280, 900);
    route.pathname = "/";
    await using screen = await render(
      <AppSidebarLayout>
        <div>Threads</div>
      </AppSidebarLayout>,
      { router: false },
    );
    const { container } = screen;
    expect(container.querySelector("[data-app-sidebar]")).not.toBeNull();
    expect(container.textContent).toContain("Thread navigation");
    expect(container.querySelector("[data-sidebar-control]")).not.toBeNull();
  });
});
