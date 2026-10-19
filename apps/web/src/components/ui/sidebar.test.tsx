// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Sidebar, SidebarProvider, SidebarTrigger } from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderSidebar(open: boolean) {
  await act(async () => {
    root.render(
      <SidebarProvider open={open}>
        <Sidebar>
          <SidebarTrigger data-testid="internal-trigger" />
          <button data-testid="sidebar-control">Thread</button>
        </Sidebar>
        <SidebarTrigger data-testid="external-trigger" />
        <button data-testid="content-control">Content</button>
      </SidebarProvider>,
    );
  });
}

function element(selector: string) {
  const node = container.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

describe("responsive sidebar state", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });
});

describe("desktop sidebar focus", () => {
  it("moves focus to the external toggle on collapse and restores sidebar access on expansion", async () => {
    await renderSidebar(true);
    const control = element('[data-testid="sidebar-control"]');
    const sidebar = element('[data-slot="sidebar"]');
    control.focus();
    expect(document.activeElement).toBe(control);

    await renderSidebar(false);

    expect(document.activeElement).toBe(element('[data-testid="external-trigger"]'));
    expect(sidebar.hasAttribute("inert")).toBe(true);

    await renderSidebar(true);

    expect(sidebar.hasAttribute("inert")).toBe(false);
    control.focus();
    expect(document.activeElement).toBe(control);
  });

  it("keeps focus in the content when the sidebar collapses", async () => {
    await renderSidebar(true);
    const control = element('[data-testid="content-control"]');
    control.focus();
    expect(document.activeElement).toBe(control);

    await renderSidebar(false);

    expect(document.activeElement).toBe(control);
  });
});
