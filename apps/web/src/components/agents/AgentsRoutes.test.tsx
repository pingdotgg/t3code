// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
vi.mock("./AgentHandoffDialog", () => ({ AgentHandoffDialog: () => <div>Handoff dialog</div> }));
vi.mock("./AgentChatRail", () => ({
  AgentChatRail: () => <nav aria-label="Active and unread agent chats" />,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../hooks/useSettings", () => ({
  useLegacySidebarEnabled: () => false,
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShell: () => ({}),
  useThreadDetail: () => ({}),
  useThreadStatus: () => "ready",
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
vi.mock("../sidebar/SidebarChrome", () => ({ SidebarChromeHeader: () => null }));
vi.mock("../ChatView", () => ({
  default: () => {
    const sidebar = useSidebar();
    return (
      <div>
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
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(async () => {
  await act(async () => root.render(null));
});
describe("Agents route shell", () => {
  it.each(["/agents", "/agents/machine/thread"])(
    "hides navigation on %s and keeps chat's sidebar context usable",
    async (pathname) => {
      route.pathname = pathname;
      await act(async () =>
        root.render(
          <AppSidebarLayout>
            <AgentsThreadView environmentId="machine" threadId="thread" />
          </AppSidebarLayout>,
        ),
      );
      expect(container.querySelector("[data-app-sidebar]")).toBeNull();
      expect(container.querySelector("[data-sidebar-control]")).toBeNull();
      expect(container.textContent).not.toContain("Thread navigation");
      expect(container.querySelector("textarea")).not.toBeNull();
      expect(
        container.querySelector('nav[aria-label="Active and unread agent chats"]'),
      ).not.toBeNull();
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Toggle context")!
          .click(),
      );
      expect(container.textContent).toContain("context closed");
    },
  );
  it("restores the regular sidebar when leaving agents", async () => {
    route.pathname = "/";
    await act(async () =>
      root.render(
        <AppSidebarLayout>
          <div>Threads</div>
        </AppSidebarLayout>,
      ),
    );
    expect(container.querySelector("[data-app-sidebar]")).not.toBeNull();
    expect(container.textContent).toContain("Thread navigation");
    expect(container.querySelector("[data-sidebar-control]")).not.toBeNull();
  });
});
