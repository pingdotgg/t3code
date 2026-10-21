import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "../../test/render";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import "../index.css";

const mocks = vi.hoisted(() => ({ side: "left" as "left" | "right" }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { sidebarSide: "left" | "right" }) => unknown) =>
    select({ sidebarSide: mocks.side }),
  useEnvironmentIdentificationMode: () => "none",
  useLegacySidebarEnabled: () => false,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../hooks/useThreadVisitedMigration", () => ({ useThreadVisitedMigration: () => {} }));
vi.mock("../hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => null }));
vi.mock("../hooks/showThreadUndoNotice", () => ({
  releaseThreadUndoShortcut: () => {},
  threadUndoClaimsShortcut: () => false,
  undoLatestThreadAction: () => false,
}));
vi.mock("../keybindings", () => ({
  isRichTextBoldShortcut: () => false,
  resolveShortcutCommand: () => null,
  shortcutLabelForCommand: () => null,
}));
vi.mock("./LegacySidebar", () => ({ default: () => <div>Legacy threads</div> }));
vi.mock("./Sidebar", () => ({ default: () => <div>Threads</div> }));
vi.mock("./settings/SettingsSidebarNav", () => ({
  SettingsSidebarNav: () => <div>Settings navigation</div>,
}));
vi.mock("./sidebar/mainAppLocation", () => ({ MainAppLocationTracker: () => null }));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarBrandWidthProbe: () => null,
  SidebarChromeHeader: () => <div>Settings</div>,
}));
vi.mock("./SidebarStageBackdrop", () => ({ useSidebarStageBackdropVariant: () => null }));
vi.mock("../env", () => ({ isElectron: true }));

function Draft() {
  const [value, setValue] = useState("");
  return (
    <SidebarInset>
      <WorkspacePageHeader>
        <span>Current thread</span>
      </WorkspacePageHeader>
      <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />
      <button className="fixed right-[var(--workspace-viewport-controls-right)]">Chat tools</button>
      <button className="absolute top-15 right-[var(--workspace-controls-right)]">
        Panel tools
      </button>
    </SidebarInset>
  );
}

function setup() {
  mocks.side = "left";
}

describe("main sidebar position", () => {
  it("moves the navigation and workspace without losing the draft, and collapses on either side", async () => {
    setup();
    await page.viewport(1280, 800);
    await using screen = await render(
      <AppSidebarLayout>
        <Draft />
      </AppSidebarLayout>,
    );
    const navigation = () => screen.container.querySelector<HTMLElement>("[data-app-sidebar]")!;
    const main = () => screen.container.querySelector("main")!;
    await vi.waitFor(() => {
      expect(navigation().getBoundingClientRect().left).toBe(0);
      expect(main().getBoundingClientRect().left).toBe(navigation().getBoundingClientRect().right);
    });
    await userEvent.fill(screen.getByRole("textbox", { name: "Draft" }), "Keep this draft");
    const panelTools = () =>
      screen.getByRole("button", { name: "Panel tools" }).element().getBoundingClientRect();
    const localControlInset = main().getBoundingClientRect().right - panelTools().right;
    mocks.side = "right";
    await screen.rerender(
      <AppSidebarLayout>
        <Draft />
      </AppSidebarLayout>,
    );
    await vi.waitFor(() => {
      expect(navigation().getBoundingClientRect().right).toBe(window.innerWidth);
      expect(main().getBoundingClientRect().right).toBe(navigation().getBoundingClientRect().left);
      const tools = screen
        .getByRole("button", { name: "Chat tools" })
        .element()
        .getBoundingClientRect();
      expect(tools.right).toBeLessThanOrEqual(navigation().getBoundingClientRect().left);
      expect(main().getBoundingClientRect().right - panelTools().right).toBe(localControlInset);
    });
    await expect
      .element(screen.getByRole("textbox", { name: "Draft" }))
      .toHaveValue("Keep this draft");
    await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar" }));
    await vi.waitFor(() => expect(main().getBoundingClientRect().width).toBe(window.innerWidth));
    await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar" }));
    await vi.waitFor(() =>
      expect(main().getBoundingClientRect().width).toBeLessThan(window.innerWidth),
    );
    mocks.side = "left";
    await screen.rerender(
      <AppSidebarLayout>
        <Draft />
      </AppSidebarLayout>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar" }));
    await vi.waitFor(() => expect(main().getBoundingClientRect().width).toBe(window.innerWidth));
    await expect
      .element(screen.getByRole("textbox", { name: "Draft" }))
      .toHaveValue("Keep this draft");
  });

  it("keeps mobile navigation on the left when right is selected", async () => {
    setup();
    mocks.side = "right";
    await page.viewport(390, 844);
    await using screen = await render(
      <AppSidebarLayout>
        <Draft />
      </AppSidebarLayout>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar" }));
    await expect.element(page.getByRole("navigation", { name: "Threads" })).toBeVisible();
    await vi.waitFor(() => {
      const bounds = page
        .getByRole("navigation", { name: "Threads" })
        .element()
        .getBoundingClientRect();
      expect(bounds.left).toBeLessThan(20);
      expect(bounds.right).toBeLessThan(window.innerWidth);
    });
  });
});
