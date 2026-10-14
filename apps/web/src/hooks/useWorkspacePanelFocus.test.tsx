// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("./useAccessibilitySupport", () => ({ useAccessibilitySupport: () => false }));
import { useWorkspacePanelFocus } from "./useWorkspacePanelFocus";
import { useWorkspaceFocusRecovery } from "./useWorkspaceFocusRecovery";
import { useRightPanelStore } from "../rightPanelStore";
import {
  WorkspaceNavigation,
  useWorkspaceArea,
  useWorkspacePageFocus,
} from "../components/WorkspaceNavigation";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("focus-test"),
};
const threadKey = scopedThreadKey(threadRef);
let root: Root;
let container: HTMLDivElement;
function Fixture() {
  useWorkspacePanelFocus(threadRef);
  const state = useRightPanelStore((value) => value.byThreadKey[threadKey]);
  const maximized = state?.isOpen === true && state.maximized === true;
  useWorkspaceFocusRecovery('[data-workspace-area="composer"]', maximized, "panel");
  const composer = useWorkspaceArea("composer", 2, "Message input");
  const panel = useWorkspaceArea("panel", 4, "Workspace panel");
  return (
    <>
      <WorkspaceNavigation />
      <section {...composer} inert={maximized}>
        <textarea aria-label="Message input" />
      </section>
      {state?.isOpen ? (
        <section {...panel} data-workspace-focus-key={`panel:${state.activeSurfaceId}`}>
          <button>Surface tab</button>
          <div data-right-panel-surface-content key={state.activeSurfaceId}>
            <input aria-label={`Search ${state.activeSurfaceId}`} data-workspace-focus-default />
            <button aria-label={`Refresh ${state.activeSurfaceId}`}>Refresh</button>
          </div>
        </section>
      ) : null}
    </>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function frame() {
  await act(async () => vi.advanceTimersToNextFrame());
}
const focusedLabel = () => document.activeElement?.getAttribute("aria-label");

it("focuses deliberate opening, restores each surface's last control, and recovers the composer when closed", async () => {
  container.querySelector("textarea")!.focus();
  await act(async () => useRightPanelStore.getState().open(threadRef, "files"));
  await frame();
  expect(focusedLabel()).toBe("Search files");
  container.querySelector<HTMLButtonElement>('[aria-label="Refresh files"]')!.focus();
  await act(async () => useRightPanelStore.getState().open(threadRef, "diff"));
  await frame();
  expect(focusedLabel()).toBe("Search diff");
  await act(async () => useRightPanelStore.getState().activateSurface(threadRef, "files"));
  await frame();
  expect(focusedLabel()).toBe("Refresh files");
  container.querySelector("textarea")!.focus();
  await act(async () => useRightPanelStore.getState().open(threadRef, "files"));
  await frame();
  expect(focusedLabel()).toBe("Refresh files");
  await act(async () => useRightPanelStore.getState().close(threadRef));
  await frame();
  expect(focusedLabel()).toBe("Message input");
  await act(async () => useRightPanelStore.getState().show(threadRef));
  await frame();
  expect(focusedLabel()).toBe("Refresh files");
});

it("does not focus automatic openings, background reconciliation, or another thread's panel", async () => {
  const composer = container.querySelector("textarea")!;
  composer.focus();
  await act(async () =>
    useRightPanelStore.getState().openProactive(threadRef, { id: "diff", kind: "diff" }, 0),
  );
  await frame();
  expect(document.activeElement).toBe(composer);
  await act(async () =>
    useRightPanelStore
      .getState()
      .open({ ...threadRef, threadId: ThreadId.make("background") }, "files"),
  );
  await frame();
  expect(document.activeElement).toBe(composer);
  await act(async () => useRightPanelStore.getState().reconcileBrowserSurfaces(threadRef, []));
  await frame();
  expect(document.activeElement).toBe(composer);
});

it("recovers focus when persisted panel maximization hides the chat column and when the panel closes", async () => {
  await act(async () => useRightPanelStore.getState().open(threadRef, "files"));
  await frame();
  container.querySelector<HTMLButtonElement>('[aria-label="Refresh files"]')!.focus();
  container.querySelector("textarea")!.focus();
  await act(async () => useRightPanelStore.getState().setMaximized(threadRef, true));
  await frame();
  expect(focusedLabel()).toBe("Refresh files");
  await act(async () => useRightPanelStore.getState().close(threadRef));
  await frame();
  expect(focusedLabel()).toBe("Message input");
  await act(async () => useRightPanelStore.getState().show(threadRef));
  await frame();
  expect(focusedLabel()).toBe("Refresh files");
});

it("waits for the destination to mount, but cancels a delayed request after subsequent typing", async () => {
  requestWorkspaceFocus({ area: "later" });
  await frame();
  const later = document.createElement("section");
  later.dataset.workspaceArea = "later";
  later.innerHTML = '<input aria-label="New page search">';
  container.append(later);
  await act(async () => {});
  await frame();
  expect(focusedLabel()).toBe("New page search");
  requestWorkspaceFocus({ area: "never-mounted" });
  await act(async () => {});
  const composer = container.querySelector("textarea")!;
  composer.focus();
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  later.dataset.workspaceArea = "never-mounted";
  container.append(document.createElement("div"));
  await act(async () => {});
  await frame();
  expect(document.activeElement).toBe(composer);
});

function Page({ name, section }: { name: string; section: string }) {
  useWorkspacePageFocus(name);
  return (
    <>
      <WorkspaceNavigation />
      <main {...useWorkspaceArea(name, 1, name)}>
        <input aria-label="Page search" />
        <button>{section}</button>
      </main>
    </>
  );
}
it("focuses each mounted page once and preserves deliberate focus during internal navigation", async () => {
  await act(async () => root.render(<Page name="settings" section="General" />));
  await frame();
  await frame();
  expect(focusedLabel()).toBe("Page search");
  const section = container.querySelector("button")!;
  section.focus();
  await act(async () => root.render(<Page name="settings" section="Appearance" />));
  await frame();
  expect(document.activeElement).toBe(section);
  await act(async () => root.render(<Page name="usage" section="Usage" />));
  await frame();
  await frame();
  expect(focusedLabel()).toBe("Page search");
});
