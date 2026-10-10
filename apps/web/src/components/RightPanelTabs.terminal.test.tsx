// @vitest-environment jsdom

import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { RightPanelTabs } from "./RightPanelTabs";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Shows the thread's surfaces from the real right-panel store and opens the
// terminal into it the way ChatView's addTerminalSurface does.
function Harness({ terminalAvailable }: { terminalAvailable: boolean }) {
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
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
      surfaces={surfaces}
      environmentId={threadRef.environmentId}
      activeSurfaceId={surfaces[0]?.id ?? null}
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
        preview: { available: false, onOpen: () => undefined },
        diff: { available: false, onOpen: () => undefined },
        terminal: {
          available: terminalAvailable,
          onOpen: () => useRightPanelStore.getState().openTerminal(threadRef, "term-1"),
        },
        device: { available: false, onOpen: () => undefined },
        "pull-request": { available: false, onOpen: () => undefined },
        "pull-requests": { available: false, onOpen: () => undefined },
      }}
      onAddBrowserInProfile={() => undefined}
      onAddFiles={() => undefined}
      filesAvailable={false}
    >
      {null}
    </RightPanelTabs>
  );
}

function launcherRow(label: string): HTMLElement {
  const launcher = container.querySelector('[aria-label="Open a surface"]');
  // Unavailable rows render as aria-disabled elements rather than buttons.
  const row = [
    ...(launcher?.querySelectorAll<HTMLElement>('button, [aria-disabled="true"]') ?? []),
  ].find((element) => element.textContent?.startsWith(label));
  if (!row) throw new Error(`No launcher row ${label}`);
  return row;
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

const threadSurfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces;

describe("opening Terminal from the launcher", () => {
  it("opens a terminal surface from the row when a project allows it", async () => {
    await act(async () => root.render(<Harness terminalAvailable />));

    await click(launcherRow("Terminal"));
    expect(threadSurfaces()).toMatchObject([{ kind: "terminal", activeTerminalId: "term-1" }]);
    expect(container.querySelector('[aria-label="Open a surface"]')).toBeNull();
    expect(container.textContent).toContain("Terminal 1");
  });

  it("keeps the row disabled and opens nothing without a project", async () => {
    await act(async () => root.render(<Harness terminalAvailable={false} />));

    const row = launcherRow("Terminal");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    await click(row);
    expect(threadSurfaces()).toEqual([]);
    expect(container.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
  });
});
