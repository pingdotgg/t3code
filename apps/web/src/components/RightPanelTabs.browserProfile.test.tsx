// @vitest-environment jsdom

import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The profile list normally comes from client settings; the built-ins are enough to choose from.
vi.mock("~/browser/browserDefaults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/browserDefaults")>()),
  useBrowserDefaults: () => ({ profiles: BUILT_IN_BROWSER_PROFILES }),
}));

import { RightPanelTabs } from "./RightPanelTabs";

let root: Root;
let container: HTMLDivElement;
let opened: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Browser is desktop-only; the launcher offers it once the preview bridge exists.
  vi.stubGlobal("desktopBridge", { preview: {} });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lacks the Web Animations API that the tab bar's scroll area waits on.
  Element.prototype.getAnimations ??= () => [];
  opened = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Records Browser opens the way ChatView's createBrowserSurface does: one
// handler for the default open and the profile chooser, where an omitted
// profile means the default one.
function Harness() {
  const openBrowser = (profileId?: string) => {
    opened.push(profileId ?? DEFAULT_BROWSER_PROFILE_ID);
  };
  return (
    <RightPanelTabs
      mode="inline"
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      panels={{
        preview: { available: true, onOpen: openBrowser },
        diff: { available: false, onOpen: () => undefined },
        terminal: { available: false, onOpen: () => undefined },
        device: { available: false, onOpen: () => undefined },
        "pull-request": { available: false, onOpen: () => undefined },
        "pull-requests": { available: false, onOpen: () => undefined },
        files: { available: false, onOpen: () => undefined },
      }}
      onAddBrowserInProfile={openBrowser}
    >
      {null}
    </RightPanelTabs>
  );
}

function launcherRow(label: string): HTMLButtonElement {
  const launcher = container.querySelector('[aria-label="Open a surface"]');
  const row = [...(launcher?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.startsWith(label),
  );
  if (!row) throw new Error(`No launcher row ${label}`);
  return row;
}

function menuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label,
  );
  if (!item) throw new Error(`No menu item ${label}`);
  return item;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("opening Browser from the launcher", () => {
  it("opens the default profile from the row and another profile from the chooser", async () => {
    await act(async () => root.render(<Harness />));

    await click(launcherRow("Browser"));
    expect(opened).toEqual([DEFAULT_BROWSER_PROFILE_ID]);

    await click(container.querySelector('[aria-label="Open browser in a profile"]')!);
    await click(menuItem("Incognito"));
    expect(opened).toEqual([DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID]);
  });
});
