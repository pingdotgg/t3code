import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { RightPanelTabs } from "./RightPanelTabs";
import { act, render } from "../../test/render";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));

const noop = () => undefined;

function panel(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
  return (
    <RightPanelTabs
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
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
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
      onAddDiff={noop}
      onAddFiles={noop}
      onAddIssues={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      issuesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...overrides}
    >
      content
    </RightPanelTabs>
  );
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  return event;
}

describe("right panel new-tab shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const addFiles = vi.fn();
      await using _screen = await render(panel({ onAddFiles: addFiles }));
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')?.textContent).toContain("Linked items");
        expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
      });
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      await vi.waitFor(() => {
        expect(addFiles).toHaveBeenCalledOnce();
        expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
      });
    },
  );

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using _screen = await render(panel({ open: false }));
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await using screen = await render(
        panel({
          getShortcutContext: () => ({
            terminalFocus: true,
            terminalOpen: true,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          }),
        }),
      );
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      screen.container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(
      panel({
        keybindings: compileResolvedKeybindingsConfig([
          { key: "mod+y", command: "rightPanel.new" },
        ]),
      }),
    );
    const input = document.createElement("input");
    screen.container.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    await vi.waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull());
    await press("Escape");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
      expect(document.activeElement).toBe(
        screen.container.querySelector('[aria-label="Add panel surface"]'),
      );
    });
  });

  it("does not open over another popup or during text composition", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(panel());
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    dialog.dataset.open = "";
    screen.container.append(dialog);
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const addFiles = vi.fn();
    const props = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
      onAddFiles: addFiles,
    };
    await using screen = await render(panel(props));
    await press("t", { metaKey: true });
    await vi.waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull());
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await screen.rerender(panel({ ...props, open: false }));
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    await screen.rerender(panel(props));
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });
});
