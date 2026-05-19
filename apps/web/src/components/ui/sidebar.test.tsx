import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Sidebar,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarRail,
} from "./sidebar";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

function renderSidebarRail(props?: { defaultOpen?: boolean; side?: "left" | "right" }) {
  return renderToStaticMarkup(
    <SidebarProvider defaultOpen={props?.defaultOpen ?? true}>
      <Sidebar side={props?.side ?? "left"} collapsible="offcanvas" resizable>
        <div>Sidebar content</div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("pins resize rails inside expanded sidebar edges", () => {
    const leftHtml = renderSidebarRail({ side: "left" }).replaceAll("&amp;", "&");
    const rightHtml = renderSidebarRail({ side: "right" }).replaceAll("&amp;", "&");

    expect(leftHtml).toContain("[[data-side=left][data-state=expanded]_&]:right-0");
    expect(leftHtml).toContain("[[data-side=left][data-state=expanded]_&]:after:right-0");
    expect(rightHtml).toContain("[[data-side=right][data-state=expanded]_&]:left-0");
    expect(rightHtml).toContain("[[data-side=right][data-state=expanded]_&]:after:left-0");
  });

  it("keeps collapsed offcanvas rails non-interactive", () => {
    const html = renderSidebarRail({ defaultOpen: false, side: "right" }).replaceAll("&amp;", "&");

    expect(html).toContain(
      "[[data-collapsible=offcanvas][data-state=collapsed]_&]:pointer-events-none",
    );
    expect(html).toContain(
      "[[data-side=right][data-collapsible=offcanvas][data-state=collapsed]_&]:-left-2",
    );
  });
});
