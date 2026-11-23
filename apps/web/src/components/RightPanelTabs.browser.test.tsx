import "~/index.css";

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";

import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import type { RightPanelSurface, TerminalPanelSurface } from "~/rightPanelStore";
import { render, stubGlobal } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";
import { RightPanelTabs, type RightPanelTabsProps } from "./RightPanelTabs";
import {
  RightPanelTerminalDrawer,
  type RightPanelTerminalDrawerProps,
} from "./RightPanelTerminalDrawer";
import { createTerminalBodyHosts } from "./terminalBodyHosts";
import { subscribePreviewAction } from "./preview/previewActionBus";

const navigateHistory = vi.hoisted(() => vi.fn());
vi.mock("../navigationHistory", () => ({ canNavigateHistory: () => true, navigateHistory }));

const terminalFixture = vi.hoisted(() => ({
  sessions: [] as Array<{ target: { terminalId: string }; state: { summary: unknown } }>,
}));
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => terminalFixture.sessions,
}));

// Chromium starts a gesture scroll, and Electron reports its begin, only for a
// wheel event the page did not preventDefault; it then scrolls the latched scroller.
function trackpad() {
  const begin = new Set<() => void>();
  const end = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let scrolling = false;
  return {
    bridge: {
      onTrackpadScrollBegin: subscribe(begin),
      onTrackpadScrollEnd: subscribe(end),
      onMenuAction: () => () => {},
    },
    scroll(target: Element, deltas: readonly number[]) {
      let scroller: Element | null = target;
      while (
        scroller &&
        (scroller.scrollWidth <= scroller.clientWidth ||
          !/auto|scroll/.test(getComputedStyle(scroller).overflowX))
      ) {
        scroller = scroller.parentElement;
      }
      for (const deltaX of deltas) {
        const event = new WheelEvent("wheel", {
          deltaX,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        target.dispatchEvent(event);
        if (event.defaultPrevented) continue;
        if (scroller) scroller.scrollLeft += deltaX;
        if (scrolling) continue;
        scrolling = true;
        for (const listener of begin) listener();
      }
      if (scrolling) for (const listener of end) listener();
      scrolling = false;
    },
  };
}

const surfaces: RightPanelSurface[] = Array.from({ length: 16 }, (_, index) => ({
  id: `browser:${index}`,
  kind: "preview",
  resourceId: `${index}`,
}));

describe("RightPanelTabs", () => {
  it("a flick that scrolls the tab strip to its left edge keeps the thread, a swipe from the edge goes back", async () => {
    navigateHistory.mockReset();
    const { bridge, scroll } = trackpad();
    using _bridge = stubGlobal("desktopBridge", bridge);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const panel = document.createElement("div");
    panel.style.cssText = "width: 320px; height: 200px; display: flex";
    const noop = () => {};
    await using screen = await render(
      <>
        <HistorySwipeNavigation />
        <RightPanelTabs
          mode="embedded"
          keybindings={[]}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          })}
          surfaces={surfaces}
          environmentId={null}
          activeSurfaceId={null}
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map(surfaces.map((surface) => [surface.id, "Terminal"]))}
          onActivate={noop}
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddBrowser={noop}
          onAddBrowserInProfile={noop}
          onAddTerminal={noop}
          onAddDiff={noop}
          onAddFiles={noop}
          onAddPullRequest={noop}
          onAddPullRequests={noop}
          onAddDevice={noop}
          browserAvailable={false}
          terminalAvailable
          diffAvailable={false}
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
          rail={null}
        >
          {null}
        </RightPanelTabs>
      </>,
      { container: panel },
    );
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-right-panel-tab-list] [data-slot="scroll-area-viewport"]',
    )!;
    expect(viewport.scrollWidth - viewport.clientWidth).toBeGreaterThan(120);
    viewport.scrollLeft = 120;

    const momentum = Array.from({ length: 24 }, (_, index) => -60 * 0.85 ** index);
    scroll(viewport.querySelector("[data-active-tab]")!, [-10, -20, -30, ...momentum]);

    expect(viewport.scrollLeft).toBe(0);
    expect(navigateHistory).not.toHaveBeenCalled();

    viewport.scrollLeft = 0;
    scroll(viewport.querySelector("[data-active-tab]")!, [-40, -40, -40, -40, -40]);

    expect(navigateHistory).toHaveBeenCalledExactlyOnceWith("back");
  });
});

const BROWSER_SURFACE: RightPanelSurface = {
  id: "browser:tab-1",
  kind: "preview",
  resourceId: "tab-1",
};
const DIFF_SURFACE: RightPanelSurface = { id: "diff", kind: "diff" };

function panel(activeSurface: RightPanelSurface) {
  const noop = () => {};
  const props: RightPanelTabsProps = {
    mode: "inline",
    keybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: true,
      isWeb: true,
      isDesktop: false,
    }),
    surfaces: [BROWSER_SURFACE, DIFF_SURFACE],
    environmentId: EnvironmentId.make("environment-local"),
    activeSurfaceId: activeSurface.id,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: noop,
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: true,
    rail: {
      groups: ["changes", "browser", "files", "reviews", "devices"],
      dots: new Set(),
      terminalOpen: false,
      shortcutLabels: {},
      onToggleTerminal: noop,
    },
    children: (
      <div data-testid="surface-content">
        {/* Stands in for ServerBrowserSurface, whose page canvas handles thumb buttons itself. */}
        <canvas data-testid="page-canvas" onMouseUp={(event) => event.preventDefault()} />
        <InputGroup>
          <InputGroupInput aria-label="Address" />
          <InputGroupAddon data-testid="address-addon" align="inline-end" />
        </InputGroup>
      </div>
    ),
  };
  return <RightPanelTabs {...props} />;
}

// Chromium focuses on an uncancelled mousedown and runs history back/forward on an
// uncancelled button 3/4 mouseup.
function releaseThumbButton(
  target: Element,
  button: 3 | 4,
): { focusMoved: boolean; routerMoved: boolean } {
  const focused = document.activeElement;
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button });
  const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, button });
  target.dispatchEvent(down);
  target.dispatchEvent(up);
  return {
    focusMoved: !down.defaultPrevented || document.activeElement !== focused,
    routerMoved: !up.defaultPrevented,
  };
}

const STAYS_PUT = { focusMoved: false, routerMoved: false };

describe("right panel thumb buttons", () => {
  it("keep the app router still over a surface that is not a browser", async () => {
    await using screen = await render(panel(DIFF_SURFACE));
    const tabStrip = screen.container.querySelector("[data-right-panel-tabbar]")!;
    const content = screen.getByTestId("surface-content").element();

    expect(releaseThumbButton(tabStrip, 3)).toEqual(STAYS_PUT);
    expect(releaseThumbButton(tabStrip, 4)).toEqual(STAYS_PUT);
    expect(releaseThumbButton(content, 3)).toEqual(STAYS_PUT);
    expect(releaseThumbButton(content, 4)).toEqual(STAYS_PUT);
  });

  it("go back and forward in the active browser tab instead of the app router", async () => {
    const actions: string[] = [];
    using _subscription = { [Symbol.dispose]: subscribePreviewAction((a) => actions.push(a)) };
    await using screen = await render(panel(BROWSER_SURFACE));
    const tabStrip = screen.container.querySelector("[data-right-panel-tabbar]")!;
    const content = screen.getByTestId("surface-content").element();

    expect(releaseThumbButton(tabStrip, 3)).toEqual(STAYS_PUT);
    expect(releaseThumbButton(content, 4)).toEqual(STAYS_PUT);
    // The address addon focuses its input on press; a thumb press must leave focus alone.
    expect(releaseThumbButton(screen.getByTestId("address-addon").element(), 3)).toEqual(STAYS_PUT);
    expect(actions).toEqual(["back", "forward", "back"]);

    // The page canvas already went back in the tab; the panel must not go back a second time.
    releaseThumbButton(screen.getByTestId("page-canvas").element(), 3);
    expect(actions).toEqual(["back", "forward", "back"]);
  });
});

const DEVICE_SURFACE: RightPanelSurface = {
  id: "device:host:phone",
  kind: "device",
  target: { hostId: "host", deviceId: "phone", platform: "ios", name: "Phone" },
};

describe("device tab rename", () => {
  it("keeps the editor open on an Enter that confirms an IME candidate", async () => {
    const onRenameDevice = vi.fn();
    const props = panel(DEVICE_SURFACE).props as RightPanelTabsProps;
    await using screen = await render(
      <RightPanelTabs {...props} surfaces={[DEVICE_SURFACE]} onRenameDevice={onRenameDevice}>
        {null}
      </RightPanelTabs>,
    );
    await userEvent.dblClick(screen.getByRole("button", { name: "Phone", exact: true }));
    const input = screen.getByRole("textbox", { name: "Device tab name" });
    await userEvent.fill(input, "にほん");

    for (const shape of [
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 },
    ]) {
      input
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...shape }),
        );
    }

    await expect.element(input).toHaveFocus();
    expect(onRenameDevice).not.toHaveBeenCalled();
    await userEvent.fill(input, "日本語");
    await userEvent.keyboard("{Enter}");
    expect(onRenameDevice).toHaveBeenCalledExactlyOnceWith(DEVICE_SURFACE.id, "日本語");
  });
});

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("t"));
const TERMINAL_SURFACE: TerminalPanelSurface = {
  id: "terminal:vitest",
  kind: "terminal",
  resourceId: "vitest",
  terminalIds: ["vitest"],
  activeTerminalId: "vitest",
};

// The real host carries a thread's attached terminals; the drawer only moves the element.
const TERMINAL_HOST = (() => {
  const element = document.createElement("div");
  element.innerHTML = '<div data-terminal-owner="right-panel"></div>';
  return {
    threadRef: THREAD_REF,
    element,
    place: (slot: HTMLElement) => slot.appendChild(element),
    park: () => element.remove(),
  };
})();

function drawerProps(
  overrides: Partial<RightPanelTerminalDrawerProps> = {},
): RightPanelTerminalDrawerProps {
  const noop = () => {};
  return {
    threadRef: THREAD_REF,
    surfaces: [TERMINAL_SURFACE],
    activeSurfaceId: TERMINAL_SURFACE.id,
    open: true,
    height: 280,
    maximized: false,
    terminalAvailable: true,
    terminalClosable: true,
    terminalLabelsById: new Map([["vitest", "vitest"]]),
    bodyHost: TERMINAL_HOST,
    onToggleOpen: noop,
    onHeightCommit: noop,
    onToggleMaximized: noop,
    onActivateSurface: noop,
    onCloseSurface: noop,
    onNewTerminal: noop,
    ...overrides,
  };
}

function sizedContainer(height: number) {
  const container = document.createElement("div");
  container.style.cssText = `width: 480px; height: ${height}px; display: flex; flex-direction: column`;
  return container;
}

const SECOND_BROWSER: RightPanelSurface = {
  id: "browser:tab-2",
  kind: "preview",
  resourceId: "tab-2",
};
const FILE_SURFACE: RightPanelSurface = {
  id: "file:src/a.ts",
  kind: "file",
  relativePath: "src/a.ts",
  revealLine: null,
  revealRequestId: 1,
};

function railPanel(
  active: RightPanelSurface,
  overrides: Partial<RightPanelTabsProps> = {},
): RightPanelTabsProps {
  return {
    ...(panel(active).props as RightPanelTabsProps),
    surfaces: [DIFF_SURFACE, BROWSER_SURFACE, FILE_SURFACE, SECOND_BROWSER],
    ...overrides,
  };
}

describe("rail", () => {
  it("clicking a group shows its active surface, or creates one when it has none", async () => {
    const onActivate = vi.fn();
    const onAddDevice = vi.fn();
    await using screen = await render(
      <RightPanelTabs {...railPanel(DIFF_SURFACE, { onActivate, onAddDevice })} />,
    );
    const rail = screen.container.querySelector("[data-right-panel-rail]")!;
    await userEvent.click(rail.querySelector('[data-rail-group="browser"]')!);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(SECOND_BROWSER);
    await userEvent.click(rail.querySelector('[data-rail-group="devices"]')!);
    expect(onAddDevice).toHaveBeenCalledOnce();
  });

  it("picking a tool on the rail restores a maximized drawer, so the tool shows", async () => {
    const onToggleMaximized = vi.fn();
    const onAddDevice = vi.fn();
    await using screen = await render(
      <RightPanelTabs
        {...railPanel(DIFF_SURFACE, { onAddDevice })}
        terminalDrawer={drawerProps({ maximized: true, onToggleMaximized })}
      />,
    );
    const rail = screen.container.querySelector("[data-right-panel-rail]")!;
    await userEvent.click(rail.querySelector('[data-rail-group="browser"]')!);
    await userEvent.click(rail.querySelector('[data-rail-group="devices"]')!);
    expect(onAddDevice).toHaveBeenCalledOnce();
    expect(onToggleMaximized).toHaveBeenCalledTimes(2);
  });

  it("a group's sub-tabs list only its surfaces", async () => {
    await using screen = await render(<RightPanelTabs {...railPanel(BROWSER_SURFACE)} />);
    const tabs = [
      ...screen.container.querySelectorAll<HTMLElement>(
        "[data-right-panel-tab-list] [data-active-tab]",
      ),
    ];
    expect(tabs).toHaveLength(2);
    expect(screen.container.querySelector("[data-right-panel-tool-name]")?.textContent).toBe(
      "Browser",
    );
  });

  it("shows a static novelty dot on an inactive group and none on the active one", async () => {
    const props = railPanel(DIFF_SURFACE);
    await using screen = await render(
      <RightPanelTabs
        {...props}
        rail={{ ...props.rail!, dots: new Set(["browser", "changes", "terminal"]) }}
      />,
    );
    const rail = screen.container.querySelector("[data-right-panel-rail]")!;
    expect(rail.querySelector('[data-rail-group="browser"] [data-rail-dot]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-group="terminal"] [data-rail-dot]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-group="changes"] [data-rail-dot]')).toBeNull();
    expect(getComputedStyle(rail.querySelector("[data-rail-dot]")!).animationName).toBe("none");
  });

  it("mod+t opens the launcher and a letter creates that surface", async () => {
    const onAddDiff = vi.fn();
    await using screen = await render(
      <RightPanelTabs
        {...railPanel(BROWSER_SURFACE, {
          onAddDiff,
          keybindings: compileResolvedKeybindingsConfig([
            { key: "mod+t", command: "rightPanel.new" },
          ]),
        })}
      />,
    );
    expect(screen.container.querySelector("[data-right-panel-rail]")).not.toBeNull();
    await userEvent.keyboard("{Control>}t{/Control}");
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("d");
    expect(onAddDiff).toHaveBeenCalledOnce();
  });
});

describe("terminal drawer", () => {
  it("collapsed line shows the active terminal's label and status and opens on click", async () => {
    terminalFixture.sessions = [
      {
        target: { terminalId: "vitest" },
        state: {
          summary: {
            status: "running",
            exitCode: null,
            hasRunningSubprocess: true,
          },
        },
      },
    ];
    const onToggleOpen = vi.fn();
    await using screen = await render(
      <RightPanelTerminalDrawer {...drawerProps({ open: false, onToggleOpen })} />,
    );
    const line = screen.container.querySelector<HTMLElement>(
      "[data-right-panel-terminal-collapsed]",
    )!;
    expect(line.textContent).toContain("vitest");
    expect(line.querySelector("[data-terminal-drawer-status]")?.textContent).toBe("running");
    await userEvent.click(line);
    expect(onToggleOpen).toHaveBeenCalledOnce();
  });

  it("resizes by drag and commits the height once on release", async () => {
    const onHeightCommit = vi.fn();
    using _capture = vi
      .spyOn(Element.prototype, "setPointerCapture")
      .mockImplementation(() => undefined);
    await using screen = await render(
      <RightPanelTerminalDrawer {...drawerProps({ onHeightCommit })} />,
      { container: sizedContainer(600) },
    );
    const handle = screen.container.querySelector<HTMLElement>(
      "[data-right-panel-terminal-resize]",
    )!;
    const pointer = (type: string, clientY: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientY }),
      );
    pointer("pointerdown", 500);
    pointer("pointermove", 400);
    pointer("pointermove", 100);
    pointer("pointerup", 100);
    expect(onHeightCommit).toHaveBeenCalledExactlyOnceWith(480);
  });

  it("switching tools keeps the drawer's terminal mounted", async () => {
    const tabs = (active: RightPanelSurface) => (
      <RightPanelTabs
        {...(panel(active).props as RightPanelTabsProps)}
        terminalDrawer={drawerProps()}
      />
    );
    await using screen = await render(tabs(DIFF_SURFACE));
    const terminal = screen.container.querySelector('[data-terminal-owner="right-panel"]');
    expect(terminal).not.toBeNull();
    await screen.rerender(tabs(BROWSER_SURFACE));
    expect(screen.container.querySelector('[data-terminal-owner="right-panel"]')).toBe(terminal);
    expect(terminal!.isConnected).toBe(true);
  });

  it("a drawer remount on a thread switch keeps focus in the terminal it moves", async () => {
    const host = createTerminalBodyHosts().host(scopedThreadKey(THREAD_REF));
    host.element.innerHTML = '<textarea aria-label="Terminal input"></textarea>';
    const drawer = (key: string) => (
      <RightPanelTerminalDrawer key={key} {...drawerProps({ bodyHost: host })} />
    );
    await using screen = await render(drawer("a"));
    const input = host.element.querySelector("textarea")!;
    input.focus();
    await screen.rerender(drawer("b"));
    expect(document.activeElement).toBe(input);
  });

  it("maximize covers the tool and restore brings it back", async () => {
    const onToggleMaximized = vi.fn();
    const tabs = (maximized: boolean) => (
      <RightPanelTabs
        {...(panel(DIFF_SURFACE).props as RightPanelTabsProps)}
        terminalDrawer={drawerProps({ maximized, onToggleMaximized })}
      />
    );
    await using screen = await render(tabs(false));
    const content = screen.getByTestId("surface-content");
    await expect.element(content).toBeVisible();

    await screen.rerender(tabs(true));
    await expect.element(content).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Restore terminal" }));
    expect(onToggleMaximized).toHaveBeenCalledOnce();

    await screen.rerender(tabs(false));
    await expect.element(content).toBeVisible();
  });
});

describe("panel parity", () => {
  it("in the narrow sheet the rail is present and the terminal icon opens the drawer", async () => {
    const onToggleTerminal = vi.fn();
    const props = railPanel(DIFF_SURFACE);
    await using screen = await render(
      <RightPanelTabs
        {...props}
        mode="sheet"
        rail={{ ...props.rail!, onToggleTerminal }}
        terminalDrawer={drawerProps({ open: false })}
      />,
      { container: sizedContainer(600) },
    );
    const rail = screen.container.querySelector("[data-right-panel-rail]");
    expect(rail).not.toBeNull();
    await userEvent.click(rail!.querySelector('[data-rail-group="terminal"]')!);
    expect(onToggleTerminal).toHaveBeenCalledOnce();
  });

  it("drawer height never exceeds the sheet's height", async () => {
    await using screen = await render(
      <RightPanelTabs
        {...railPanel(DIFF_SURFACE)}
        mode="sheet"
        terminalDrawer={drawerProps({ height: 2000 })}
      />,
      { container: sizedContainer(400) },
    );
    const drawer = screen.container.querySelector<HTMLElement>(
      "[data-right-panel-terminal-drawer]",
    )!;
    const column = drawer.parentElement!;
    expect(drawer.getBoundingClientRect().height).toBeLessThanOrEqual(
      column.getBoundingClientRect().height - 120,
    );
    expect(drawer.getBoundingClientRect().height).toBeGreaterThan(0);
  });

  it("maximized panel keeps the rail and the drawer", async () => {
    await using screen = await render(
      <RightPanelTabs {...railPanel(DIFF_SURFACE)} maximized terminalDrawer={drawerProps()} />,
      { container: sizedContainer(600) },
    );
    expect(screen.container.querySelector("[data-right-panel-rail]")).not.toBeNull();
    expect(
      screen.container.querySelector('[data-right-panel-terminal-drawer="open"]'),
    ).not.toBeNull();
  });
});
