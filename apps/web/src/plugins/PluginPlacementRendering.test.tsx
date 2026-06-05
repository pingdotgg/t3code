import type { PluginCatalogEntry } from "@t3tools/contracts";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { SidebarProvider } from "../components/ui/sidebar";
import {
  PluginSidebarFooterPlacements,
  PluginSidebarPrimaryPlacements,
} from "./PluginSidebarPlacements";
import { makePluginCatalogEntry } from "./testing/pluginPlacementFixtures";

const routerMock = vi.hoisted(() => ({
  pathname: "/",
  navigate: vi.fn(),
}));

const catalogMock = vi.hoisted(() => ({
  plugins: [] as ReadonlyArray<PluginCatalogEntry>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    ...props
  }: {
    readonly to: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly children?: React.ReactNode;
  }) => {
    const href = to
      .replace("$pluginId", encodeURIComponent(params?.pluginId ?? ""))
      .replace("$routeId", encodeURIComponent(params?.routeId ?? ""));
    return <a href={href} {...props} />;
  },
  useCanGoBack: () => false,
  useLocation: <T,>(input?: { readonly select?: (location: { pathname: string }) => T }) =>
    input?.select
      ? input.select({ pathname: routerMock.pathname })
      : { pathname: routerMock.pathname },
  useNavigate: () => routerMock.navigate,
}));

vi.mock("./pluginHost", () => ({
  usePluginCatalog: () => catalogMock.plugins,
}));

function renderInSidebar(children: React.ReactNode): string {
  return renderToStaticMarkup(<SidebarProvider>{children}</SidebarProvider>);
}

describe("plugin placement rendering", () => {
  beforeEach(() => {
    routerMock.pathname = "/";
    routerMock.navigate.mockReset();
    catalogMock.plugins = [];
  });

  it("renders primary sidebar plugin placements above project navigation", () => {
    catalogMock.plugins = [
      makePluginCatalogEntry({
        pluginId: "t3.automations",
        name: "Automations",
        routeSurface: "app",
        placementId: "main-sidebar",
        placementLabel: "Automations",
        placementPosition: "sidebar.primary",
        badgeCount: 2,
      }),
    ];
    routerMock.pathname = "/plugins/t3.automations/main";

    const html = renderInSidebar(<PluginSidebarPrimaryPlacements />);

    expect(html).toContain("Automations");
    expect(html).toContain('href="/plugins/t3.automations/main"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain(">2</span>");
  });

  it("renders footer sidebar plugin placements", () => {
    catalogMock.plugins = [
      makePluginCatalogEntry({
        pluginId: "t3.footer",
        name: "Footer Plugin",
        routeSurface: "app",
        placementId: "footer",
        placementLabel: "Footer Plugin",
        placementPosition: "sidebar.footer",
      }),
    ];

    const html = renderInSidebar(<PluginSidebarFooterPlacements />);

    expect(html).toContain("Footer Plugin");
    expect(html).toContain('href="/plugins/t3.footer/main"');
  });

  it("renders settings sidebar plugin placements in a separate Plugins group", () => {
    catalogMock.plugins = [
      makePluginCatalogEntry({
        pluginId: "t3.settings",
        name: "Settings Plugin",
        routeId: "settings",
        routeSurface: "settings",
        placementId: "settings-sidebar",
        placementLabel: "Settings Plugin",
        placementPosition: "settings.sidebar",
      }),
    ];

    const html = renderInSidebar(
      <SettingsSidebarNav pathname="/settings/plugins/t3.settings/settings" />,
    );

    expect(html).toContain("Plugins");
    expect(html).toContain("Settings Plugin");
    expect(html).toContain('data-active="true"');
  });
});
