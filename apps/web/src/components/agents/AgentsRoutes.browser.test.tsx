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
vi.mock("../../hooks/useSettings", () => ({
  useLegacySidebarEnabled: () => false,
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShell: () => ({}),
  useThreadDetail: () => ({}),
  useThreadStatus: () => "ready",
  useQuietThreadShells: () => [],
}));
vi.mock("../../panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelNavigationSuppression: () => false,
  PanelAnimationSuppressionProvider: ({ children }: { children: ReactNode }) => children,
}));
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

describe("Agents route shell", () => {
  it.each(["/agents", "/agents/machine/thread"])(
    "hides navigation on %s and keeps chat's sidebar context usable",
    async (pathname) => {
      // Below the mobile breakpoint the sidebar is a sheet, not the layout under test.
      await page.viewport(1280, 900);
      // The open state persists, so an earlier case's toggle would carry over.
      localStorage.removeItem("chat_thread_sidebar_open");
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
