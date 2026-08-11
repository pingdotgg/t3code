import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  isMobile: true,
  setOpenMobile: vi.fn(),
  navigate: vi.fn(),
  voiceItemSelections: new Array<(() => void) | undefined>(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
  useCanGoBack: () => false,
  useLocation: ({
    select,
  }: {
    readonly select: (location: { readonly hash: string }) => unknown;
  }) => select({ hash: "" }),
  useNavigate: () => testState.navigate,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => null,
}));

vi.mock("../SidebarStageBackdrop", () => ({
  resolveEnvironmentIdentificationPillLabel: () => null,
  resolveSidebarStageBackdropVariant: () => null,
  SidebarStageBackdrop: () => null,
  useEnvironmentStageLabel: () => null,
}));

vi.mock("../sidebar/SidebarProviderUpdatePill", () => ({
  SidebarProviderUpdatePill: () => null,
}));

vi.mock("../sidebar/SidebarUpdatePill", () => ({ SidebarUpdatePill: () => null }));

vi.mock("../clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectSidebarAvatar: () => null,
  T3ConnectSidebarSignIn: () => null,
}));

vi.mock("../ui/sidebar", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  const MenuButton = ({ children }: { readonly children?: ReactNode }) => (
    <button type="button">{children}</button>
  );
  return {
    SidebarContent: Container,
    SidebarFooter: Container,
    SidebarGroup: Container,
    SidebarHeader: Container,
    SidebarMenu: Container,
    SidebarMenuButton: MenuButton,
    SidebarMenuItem: Container,
    SidebarTrigger: MenuButton,
    useSidebar: () => ({
      isMobile: testState.isMobile,
      setOpenMobile: testState.setOpenMobile,
      open: true,
      setOpen: vi.fn(),
    }),
  };
});

vi.mock("./VoicePanelSidebarMenuItem", () => ({
  VoicePanelSidebarMenuItem: ({ onSelect }: { readonly onSelect?: () => void }) => {
    testState.voiceItemSelections.push(onSelect);
    return <span data-voice-panel-entrypoint="">Voice</span>;
  },
}));

import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";

beforeEach(() => {
  vi.clearAllMocks();
  testState.isMobile = true;
  testState.voiceItemSelections = [];
});

describe("voice panel sidebar entry points", () => {
  it("renders in the shared modern and legacy footer and closes the mobile sidebar", () => {
    const markup = renderToStaticMarkup(<SidebarChromeFooter />);

    expect(markup).toContain("data-voice-panel-entrypoint");
    expect(testState.voiceItemSelections).toHaveLength(1);
    testState.voiceItemSelections[0]?.();
    expect(testState.setOpenMobile).toHaveBeenCalledWith(false);
  });

  it("renders in the bespoke settings footer and closes the mobile sidebar", () => {
    const markup = renderToStaticMarkup(<SettingsSidebarNav pathname="/settings/general" />);

    expect(markup).toContain("data-voice-panel-entrypoint");
    expect(testState.voiceItemSelections).toHaveLength(1);
    testState.voiceItemSelections[0]?.();
    expect(testState.setOpenMobile).toHaveBeenCalledWith(false);
  });
});
