import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  Sidebar,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
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
});

describe("SidebarTrigger", () => {
  it("renders as a close control when the desktop sidebar is open", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('aria-label="Close sidebar"');
  });

  it("renders as an open control when the desktop sidebar is closed", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('aria-label="Open sidebar"');
  });
});

describe("SidebarProvider forceDesktopLayout", () => {
  it("renders desktop sidebar positioning without breakpoint-hidden classes", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false} forceDesktopLayout>
        <Sidebar>
          <div>Projects</div>
        </Sidebar>
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain('data-state="collapsed"');
    expect(html).toContain("group peer text-sidebar-foreground block");
    expect(html).not.toContain("group peer text-sidebar-foreground hidden md:block");
    expect(html).toContain('data-slot="sidebar-container"');
    expect(html).not.toContain("hidden h-svh");
  });
});
