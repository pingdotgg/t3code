// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Sidebar, SidebarProvider, SidebarTrigger } from "./sidebar";

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

async function renderSidebar(
  open: boolean,
  collapsible: "offcanvas" | "icon" | "none" = "offcanvas",
  side: "left" | "right" = "left",
) {
  await act(async () => {
    root.render(
      <SidebarProvider open={open}>
        <Sidebar collapsible={collapsible} side={side}>
          <SidebarTrigger data-testid="internal-trigger" />
          <button data-testid="sidebar-control">Thread</button>
          <input data-testid="sidebar-input" aria-label="Search threads" />
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

describe("desktop sidebar focus", () => {
  it.each([
    { side: "left", control: "sidebar-control" },
    { side: "right", control: "sidebar-control" },
    { side: "left", control: "sidebar-input" },
    { side: "right", control: "sidebar-input" },
  ] as const)(
    "moves focus from $control to the external toggle when the $side sidebar collapses",
    async ({ side, control }) => {
      await renderSidebar(true, "offcanvas", side);
      const focusedControl = element(`[data-testid="${control}"]`);
      focusedControl.focus();
      expect(document.activeElement).toBe(focusedControl);

      await renderSidebar(false, "offcanvas", side);

      expect(document.activeElement).toBe(element('[data-testid="external-trigger"]'));
    },
  );

  it("keeps focus in the content when the sidebar collapses", async () => {
    await renderSidebar(true);
    element('[data-testid="content-control"]').focus();

    await renderSidebar(false);

    expect(document.activeElement).toBe(element('[data-testid="content-control"]'));
  });

  it.each(["icon", "none"] as const)(
    "keeps %s sidebar controls focused on collapse",
    async (collapsible) => {
      await renderSidebar(true, collapsible);
      element('[data-testid="sidebar-control"]').focus();

      await renderSidebar(false, collapsible);

      expect(document.activeElement).toBe(element('[data-testid="sidebar-control"]'));
    },
  );
});
