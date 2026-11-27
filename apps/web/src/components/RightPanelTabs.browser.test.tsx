import "~/index.css";

import {
  EnvironmentId,
  type DesktopPreviewFavicon,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import type { RightPanelSurface } from "~/rightPanelStore";
import { act, render, stubGlobal, type Screen } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";
import { RightPanelTabs, type RightPanelTabsProps } from "./RightPanelTabs";
import { subscribePreviewAction } from "./preview/previewActionBus";

const setAudioMuted = vi.hoisted(() => vi.fn(async () => undefined));
const navigateHistory = vi.hoisted(() => vi.fn());

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: [] }) as never,
}));
vi.mock(import("./preview/previewBridge"), () => ({
  previewBridge: { setAudioMuted } as never,
}));
vi.mock("../navigationHistory", () => ({ canNavigateHistory: () => true, navigateHistory }));

// A real 1x1 PNG, so the browser keeps it instead of falling back on a decode error.
const PIXEL_A =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PIXEL_B =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};
const sessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
};

const favicon = (dataUrl: string, pageUrl: string): DesktopPreviewFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});

function overlay(
  icon: DesktopPreviewFavicon | null,
  audio?: { audible?: boolean; audioMuted?: boolean },
) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    audioMuted: audio?.audioMuted ?? false,
    audible: audio?.audible ?? false,
    controller: "none" as const,
    favicon: icon,
    navStatus: {
      _tag: "Success" as const,
      url: icon?.pageUrl ?? "http://24x.xf.local/",
      title: "Local site",
    },
  };
}

const noop = () => undefined;

function setup() {
  setAudioMuted.mockClear();
}

function tabs(
  first: DesktopPreviewFavicon | null,
  second?: DesktopPreviewFavicon,
  audio?: { audible?: boolean; audioMuted?: boolean },
  previewRuntimeTabId: ((tabId: string) => string) | null = (tabId) => `runtime:${tabId}`,
) {
  return (
    <RightPanelTabs
      onAddIssues={noop}
      issuesAvailable={false}
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={second ? [previewSurface, secondSurface] : [previewSurface]}
      environmentId={null}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{
        "tab-1": overlay(first, audio),
        ...(second ? { "tab-2": overlay(second) } : {}),
      }}
      {...(previewRuntimeTabId ? { previewRuntimeTabId } : {})}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseSelectedSurfaces={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddDevice={noop}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>
  );
}

const imageSources = (screen: Screen) =>
  [...screen.container.querySelectorAll("img")].map((image) => image.src);
const button = (screen: Screen, name: string) =>
  [...screen.container.querySelectorAll("button")].find((element) => element.ariaLabel === name);

describe("preview tab favicon", () => {
  it("prefers a live capture and never asks a public provider about a private hostname", async () => {
    await using screen = await render(tabs(favicon(PIXEL_A, "http://24x.xf.local/")));
    expect(imageSources(screen)).toEqual([PIXEL_A]);

    await screen.rerender(tabs(null));
    expect(imageSources(screen)).toEqual([]);
  });

  it("keeps route-specific captures isolated between live tabs on one origin", async () => {
    await using screen = await render(
      tabs(favicon(PIXEL_A, "http://24x.xf.local/"), favicon(PIXEL_B, "http://24x.xf.local/admin")),
    );
    expect(imageSources(screen)).toEqual([PIXEL_A, PIXEL_B]);
  });

  it("hides a capture while the server session still describes another origin", async () => {
    await using screen = await render(tabs(favicon(PIXEL_A, "https://example.com/")));
    expect(imageSources(screen)).not.toContain(PIXEL_A);
  });
});

describe("preview tab audio toggle", () => {
  it.each([
    { audible: false, audioMuted: false },
    { audible: false, audioMuted: true },
  ])("is absent for a silent tab (muted=$audioMuted)", async (audio) => {
    await using screen = await render(tabs(null, undefined, audio));
    expect(button(screen, "Mute Local site")).toBeUndefined();
    expect(button(screen, "Unmute Local site")).toBeUndefined();
  });

  it.each([
    { audioMuted: false, label: "Mute Local site", nextMuted: true },
    { audioMuted: true, label: "Unmute Local site", nextMuted: false },
  ])("$label addresses the desktop by runtime tab id", async ({ audioMuted, label, nextMuted }) => {
    setup();
    await using screen = await render(tabs(null, undefined, { audible: true, audioMuted }));
    await act(() => button(screen, label)!.click());
    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith("runtime:tab-1", nextMuted);
  });

  it("hides the toggle when no runtime tab id can be resolved", async () => {
    await using screen = await render(tabs(null, undefined, { audible: true }, null));
    expect(button(screen, "Mute Local site")).toBeUndefined();
  });
});

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
  id: `terminal:${index}`,
  kind: "terminal",
  resourceId: `${index}`,
  terminalIds: [`${index}`],
  activeTerminalId: `${index}`,
}));

describe("RightPanelTabs", () => {
  it("a flick that scrolls the tab strip to its left edge keeps the thread, and so does a swipe from the edge", async () => {
    navigateHistory.mockReset();
    const { bridge, scroll } = trackpad();
    using _bridge = stubGlobal("desktopBridge", bridge);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const panel = document.createElement("div");
    panel.style.cssText = "width: 320px; height: 200px; display: flex";
    await using screen = await render(
      <>
        <HistorySwipeNavigation />
        <RightPanelTabs
          onAddIssues={noop}
          issuesAvailable={false}
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
          onCloseSelectedSurfaces={noop}
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

    expect(navigateHistory).not.toHaveBeenCalled();
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
    onCloseSelectedSurfaces: noop,
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

it("drags a Shift-clicked range and closes it from a selected tab's menu", async () => {
  const files: RightPanelSurface = { id: "files", kind: "files" };
  const linkedItems: RightPanelSurface = { id: "pull-requests", kind: "pull-requests" };
  const onMoveSurfaces = vi.fn();
  const onCloseSelectedSurfaces = vi.fn();
  await using screen = await render(
    <RightPanelTabs
      {...(panel(DIFF_SURFACE).props as RightPanelTabsProps)}
      surfaces={[DIFF_SURFACE, files, linkedItems]}
      onMoveSurfaces={onMoveSurfaces}
      onCloseSelectedSurfaces={onCloseSelectedSurfaces}
    >
      {null}
    </RightPanelTabs>,
  );
  const diffTab = screen.getByRole("button", { name: "Diff", exact: true });
  const filesTab = screen.getByRole("button", { name: "Files", exact: true });
  const linkedItemsTab = screen.getByRole("button", { name: "Linked items", exact: true });

  await userEvent.click(linkedItemsTab, { modifiers: ["Shift"] });
  await expect.element(filesTab).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(filesTab).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(filesTab, { modifiers: ["Shift"] });
  await expect.element(diffTab).toHaveAttribute("aria-pressed", "true");
  await expect.element(filesTab).toHaveAttribute("aria-pressed", "true");
  await expect.element(linkedItemsTab).toHaveAttribute("aria-pressed", "false");

  await userEvent.hover(filesTab);
  await commands.pointerDown();
  try {
    await userEvent.hover(filesTab, { position: { x: 1, y: 5 } });
    await userEvent.hover(linkedItemsTab, { force: true });
    await vi.waitFor(() => {
      const dragged = getComputedStyle(filesTab.element().closest("[data-selected-tab]")!);
      const peer = getComputedStyle(diffTab.element().closest("[data-selected-tab]")!);
      expect(dragged.transform).not.toBe("none");
      expect(peer.transform).toBe(dragged.transform);
    });
  } finally {
    await commands.pointerUp();
  }
  expect(onMoveSurfaces).toHaveBeenCalledExactlyOnceWith(["diff", "files"], "pull-requests");

  await userEvent.click(diffTab, { button: "right" });
  await userEvent.click(page.getByRole("menuitem", { name: "Close selected tabs" }));
  expect(onCloseSelectedSurfaces).toHaveBeenCalledExactlyOnceWith([DIFF_SURFACE, files]);
});

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

describe("add surface launcher", () => {
  it("hides the button, closes the open menu and stops taking Mod+T and the desktop menu action once no surface can be added", async () => {
    const menuListeners = new Set<(action: string) => void>();
    using _bridge = stubGlobal("desktopBridge", {
      onMenuAction: (listener: (action: string) => void) => {
        menuListeners.add(listener);
        return () => menuListeners.delete(listener);
      },
    });
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const tabs = (sideChatAvailable: boolean) => (
      <RightPanelTabs
        {...(panel(DIFF_SURFACE).props as RightPanelTabsProps)}
        open
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
        onAddSideChat={() => {}}
        sideChatAvailable={sideChatAvailable}
      >
        {null}
      </RightPanelTabs>
    );
    const pressModT = async () => {
      const event = new KeyboardEvent("keydown", {
        key: "t",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(() => {
        document.body.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    await using screen = await render(tabs(true));
    const addButton = screen.getByRole("button", { name: "Add panel surface" });

    await expect.element(addButton).toBeInTheDocument();
    expect(menuListeners.size).toBe(1);
    expect(await pressModT()).toBe(true);
    await expect.element(page.getByRole("menu")).toBeVisible();

    await screen.rerender(tabs(false));
    expect(addButton.query()).toBeNull();
    expect(page.getByRole("menu").query()).toBeNull();
    expect(menuListeners.size).toBe(0);
    expect(await pressModT()).toBe(false);
    expect(page.getByRole("menu").query()).toBeNull();
  });
});
