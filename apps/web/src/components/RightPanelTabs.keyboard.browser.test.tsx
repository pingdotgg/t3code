import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { RightPanelTabs } from "./RightPanelTabs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock(import("~/browser/browserDefaults"), async (importOriginal) => ({
  ...(await importOriginal()),
  useBrowserDefaults: (() => ({ profiles: [] })) as never,
}));

let root: Root;
let container: HTMLDivElement;
const addFiles = vi.fn();
const noop = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  addFiles.mockClear();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderPanel(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
  await act(() =>
    root.render(
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
        onCloseAllSurfaces={noop}
        onCopyFilePath={noop}
        onAddBrowser={noop}
        onAddBrowserInProfile={noop}
        onAddTerminal={noop}
        onAddDiff={noop}
        onAddFiles={addFiles}
        onAddPullRequest={noop}
        onAddPullRequests={noop}
        onAddDevice={noop}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
        {...overrides}
      >
        content
      </RightPanelTabs>,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
  return event;
}

it("keeps native issue labels beside pull request tabs", async () => {
  const issue = (tracker: string, scope: string, key: string) =>
    ({
      id: `issue:${tracker}:${scope}:${key}`,
      kind: "issue",
      projectId: "p",
      tracker,
      scope,
      key,
    }) as const;
  await renderPanel({
    surfaces: [
      { ...issue("forgejo", "Mount/acme/web", "42"), connectionId: "Account/B" },
      issue("github", "acme/web", "7"),
      issue("gitlab", "acme/api", "7"),
      issue("linear", "ENG", "ENG-12"),
      issue("jira", "PROJ", "PROJ-3"),
      {
        id: "pull-request:p:acme/api:7",
        kind: "pull-request",
        projectId: "p",
        repository: "acme/api",
        number: 7,
      },
    ],
  });
  expect(
    [...container.querySelectorAll('[aria-label^="Close "]')].map((button) =>
      button.getAttribute("aria-label"),
    ),
  ).toEqual([
    "Close Mount/acme/web#42",
    "Close acme/web#7",
    "Close acme/api#7",
    "Close ENG-12",
    "Close PROJ-3",
    "Close #7",
  ]);
});

describe("right panel new-tab shortcut", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("thread-A"), ThreadId.make("thread"));
  const otherRef = scopeThreadRef(EnvironmentId.make("other-B"), ThreadId.make("thread"));
  const linkedState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

  describe.each(["inline", "sheet"] as const)("linked issues in %s mode", (mode) => {
    it.each(["empty shortcut", "menu click", "menu shortcut"] as const)(
      "opens the native thread panel using %s",
      async (entry) => {
        if (entry !== "empty shortcut") useRightPanelStore.getState().open(threadRef, "files");
        await renderPanel({
          mode,
          environmentId: threadRef.environmentId,
          ...linkedState(),
          issuesAvailable: true,
          onAddIssues: () => useRightPanelStore.getState().open(threadRef, "issues"),
        });
        if (entry === "empty shortcut") {
          expect((await press("i")).defaultPrevented).toBe(true);
          await press("i");
        } else {
          await press("t", { metaKey: true });
          const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
            (element) => element.textContent?.includes("Linked issues"),
          );
          expect(item).toBeDefined();
          expect(item?.getAttribute("aria-keyshortcuts")).toBe("I");
          if (entry === "menu click") await act(() => item?.click());
          else await press("i");
          expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
        }
        expect(linkedState().surfaces.filter((surface) => surface.kind === "issues")).toEqual([
          { id: "issues", kind: "issues" },
        ]);
        expect(linkedState().activeSurfaceId).toBe("issues");
        expect(
          selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, otherRef).surfaces,
        ).toEqual([]);
      },
    );
  });

  it.each([false, true])(
    "does not launch linked issues with unavailable configuration %s",
    async (missingHandler) => {
      await renderPanel(
        missingHandler
          ? { issuesAvailable: true }
          : {
              issuesAvailable: false,
              onAddIssues: () => useRightPanelStore.getState().open(threadRef, "issues"),
            },
      );
      expect((await press("i")).defaultPrevented).toBe(false);
      expect(
        Array.from(container.querySelectorAll("button")).some((element) =>
          element.textContent?.includes("Linked issues"),
        ),
      ).toBe(false);
      await press("t", { metaKey: true });
      await press("i");
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (element) => element.textContent?.includes("Linked issues"),
      );
      expect(item?.getAttribute("aria-disabled")).toBe("true");
      expect(linkedState().surfaces).toEqual([]);
    },
  );

  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel();
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "Linked pull requests",
      );
      expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
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
      expect(addFiles).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel({
        getShortcutContext: () => ({
          terminalFocus: true,
          terminalOpen: true,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        }),
      });
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    const input = document.createElement("input");
    await renderPanel({
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    document.body.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Add panel surface"]'),
    );
    input.remove();
  });

  it("does not open over another popup or during text composition", async () => {
    await renderPanel();
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    container.append(dialog);
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await renderPanel(panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await renderPanel({ ...panel, open: false });
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    await renderPanel(panel);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });
});
