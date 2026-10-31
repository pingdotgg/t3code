import { render as renderScreen, stubGlobal, type Screen } from "../../test/render";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

// The profile list normally comes from client settings; the built-ins are enough to choose from.
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({ profiles: BUILT_IN_BROWSER_PROFILES }),
}));

import { RightPanelTabs } from "./RightPanelTabs";

let opened: string[];

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
      }}
      onAddBrowserInProfile={openBrowser}
      onAddTerminal={() => undefined}
      onAddPullRequest={() => undefined}
      onAddPullRequests={() => undefined}
      onAddFiles={() => undefined}
      onAddDevice={() => undefined}
      terminalAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      {null}
    </RightPanelTabs>
  );
}

function launcherRow(screen: Screen, label: string): HTMLButtonElement {
  const launcher = screen.container.querySelector('[aria-label="Open a surface"]');
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
  await userEvent.click(element);
}

describe("opening Browser from the launcher", () => {
  it("opens the default profile from the row and another profile from the chooser", async () => {
    resetFixture();
    using _desktopBridge = stubGlobal("desktopBridge", { preview: {} });
    using _resizeObserver = stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    await using screen = await renderScreen(null, { router: false });
    await screen.rerender(<Harness />);

    await click(launcherRow(screen, "Browser"));
    expect(opened).toEqual([DEFAULT_BROWSER_PROFILE_ID]);

    await click(screen.container.querySelector('[aria-label="Open browser in a profile"]')!);
    await click(menuItem("Incognito"));
    expect(opened).toEqual([DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID]);
  });
});

function resetFixture() {
  opened = [];
}
