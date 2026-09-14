import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: "/" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  removeLocalStorageItem: vi.fn(),
}));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useLegacySidebarEnabled: () => false,
}));
vi.mock("../keybindings", () => ({
  resolveShortcutCommand: () => null,
  shortcutLabelForCommand: () => null,
}));
vi.mock("../lib/utils", () => ({
  cn: (...classes: Array<string | undefined>) => classes.filter(Boolean).join(" "),
  isMacPlatform: () => false,
}));
vi.mock("../panelAnimations", () => ({
  PanelAnimationSuppressionProvider: ({ children }: { children: ReactNode }) => children,
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelNavigationSuppression: () => false,
}));
vi.mock("../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: Symbol("keybindings") }));
vi.mock("./LegacySidebar", () => ({ default: () => null }));
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("./NavigationHistoryControls", () => ({
  NavigationHistoryControls: () => <div aria-label="Navigation history" />,
}));
vi.mock("./settings/SettingsSidebarNav", () => ({ SettingsSidebarNav: () => null }));
vi.mock("./sidebar/SidebarChrome", () => ({ SidebarChromeHeader: () => null }));
vi.mock("./SidebarStageBackdrop", () => ({
  resolveSidebarStageFocusRingOffsetClass: () => "",
  useSidebarStageBackdropVariant: () => null,
}));
vi.mock("./ui/sidebar", () => ({
  Sidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SidebarProvider: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SidebarRail: () => null,
  SidebarTrigger: (props: object) => <button {...props} />,
  useSidebar: () => ({ toggleSidebar: vi.fn() }),
  useSidebarVisibility: () => true,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));

import { AppSidebarLayout } from "./AppSidebarLayout";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1440 }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("AppSidebarLayout", () => {
  it("mounts the back and forward navigation controls", async () => {
    await act(() => {
      renderer = create(<AppSidebarLayout>Workspace</AppSidebarLayout>);
    });

    expect(renderer!.root.findByProps({ "aria-label": "Navigation history" })).toBeDefined();
  });
});
