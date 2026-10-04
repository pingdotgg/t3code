import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SidebarUtilityMenu } from "./SidebarChrome";

const { issuesSupported, navigate } = vi.hoisted(() => ({
  issuesSupported: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useIssuesSupported: issuesSupported,
  usePullRequestsSupported: () => false,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useLocation: () => null,
  Link: "a",
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false }),
  SidebarMenu: "div",
  SidebarMenuItem: "div",
  SidebarMenuButton: "button",
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("./SidebarUpdatePill", () => ({ SidebarUpdatePill: () => null }));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
});

it.each([false, true])("shows Issues when primary support is %s", async (supported) => {
  issuesSupported.mockReturnValue(supported);
  await act(() => {
    renderer = create(<SidebarUtilityMenu />);
  });
  const buttons = renderer.root.findAllByProps({ "aria-label": "Issues" });
  expect(buttons).toHaveLength(supported ? 1 : 0);
  if (supported) {
    await act(() => buttons[0]!.props.onClick());
    expect(navigate).toHaveBeenCalledWith({
      to: "/issues",
      search: { involvement: "all", state: "open" },
    });
  }
});
