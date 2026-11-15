import "~/index.css";

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import {
  type RightPanelSurface,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { render } from "../../../test/render";
import { RightPanelSplitView } from "./RightPanelSplitView";

const environmentId = EnvironmentId.make("environment-local");
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-split-view"));

const file = (name: string): RightPanelSurface => ({
  id: `file:${name}`,
  kind: "file",
  relativePath: name,
  revealLine: null,
  revealRequestId: 1,
});
const TERMINAL: RightPanelSurface = {
  id: "terminal:1",
  kind: "terminal",
  resourceId: "1",
  terminalIds: ["1"],
  activeTerminalId: "1",
};

const NO_HANDLERS: ResizableWidthHandlers = {
  ref: () => undefined,
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onLostPointerCapture: () => {},
};

function setup(thread: ThreadRightPanelState) {
  useRightPanelStore.setState({
    byThreadKey: { [scopedThreadKey(ref)]: thread },
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
}

const thread = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

function StubSurface(props: { surface: RightPanelSurface; onRender: (id: string) => void }) {
  props.onRender(props.surface.id);
  return (
    <div data-testid={`surface ${props.surface.id}`} className="flex min-h-0 flex-1 flex-col p-2">
      {props.surface.kind === "terminal" ? (
        <textarea aria-label="Terminal input" />
      ) : (
        <button type="button">Action in {props.surface.id}</button>
      )}
    </div>
  );
}

/** ChatView's wiring of the split view to the store, with stub surfaces. */
function Panel(props: { width: number; onRender: (id: string) => void }) {
  const state = useRightPanelStore((store) => selectThreadRightPanelState(store.byThreadKey, ref));
  const store = () => useRightPanelStore.getState();
  const close = (strip: readonly RightPanelSurface[]) => {
    for (const surface of strip) store().closeSurface(ref, surface.id);
  };
  const noop = () => {};
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", width: 1200, height: 480 }}>
      <RightPanelSplitView
        mode="inline"
        open
        maximized={false}
        inlineSize={{
          width: props.width,
          handlers: NO_HANDLERS,
          setWidth: noop,
          maxWidth: props.width,
          observeRow: () => noop,
        }}
        keybindings={[]}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
        surfaces={state.surfaces}
        environmentId={environmentId}
        activeSurfaceId={state.activeSurfaceId}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={(surface) => store().activateSurface(ref, surface.id)}
        onCloseSurface={(surface) => store().closeSurface(ref, surface.id)}
        onCloseOtherSurfaces={(surface, strip) =>
          close(strip.filter((entry) => entry.id !== surface.id))
        }
        onCloseSurfacesToRight={(surface, strip) =>
          close(strip.slice(strip.findIndex((entry) => entry.id === surface.id) + 1))
        }
        onCloseAllSurfaces={close}
        onMoveSurface={(surfaceId, toIndex) => store().moveSurface(ref, surfaceId, toIndex)}
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
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
        threadRef={ref}
        split={state.split}
        renderSurface={(surface) => <StubSurface surface={surface} onRender={props.onRender} />}
      />
    </div>
  );
}

function pointer(target: EventTarget, type: string, at: { x: number; y: number }) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

function center(element: Element) {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Presses a tab and drags it into the right third of the panel content, until the ghost shows. */
async function dragIntoRightThird(screen: { container: HTMLElement }, title: string) {
  const tab = page.getByRole("button", { name: title, exact: true }).element();
  const content = screen.container
    .querySelector("[data-right-panel-surface-content]")!
    .getBoundingClientRect();
  const start = center(tab);
  const target = { x: content.right - 40, y: content.top + content.height / 2 };
  pointer(tab, "pointerdown", start);
  pointer(document, "pointermove", { x: start.x + 10, y: start.y + 10 });
  pointer(document, "pointermove", target);
  const ghost = await vi.waitFor(() => {
    const element = document.querySelector("[data-right-panel-drop-ghost='box']");
    expect(element).not.toBeNull();
    expect(document.querySelector("[data-right-panel-drag-shield]")).not.toBeNull();
    return element!.getBoundingClientRect();
  });
  return { content, target, ghost };
}

describe("RightPanelSplitView", () => {
  it("splits when a background tab is dropped on the right third, keeping the source pane's tab", async () => {
    await page.viewport(1280, 800);
    setup({ isOpen: true, activeSurfaceId: "file:a.ts", surfaces: [file("a.ts"), file("b.ts")] });
    await using screen = await render(<Panel width={600} onRender={() => {}} />);

    const { content, target, ghost } = await dragIntoRightThird(screen, "b.ts");
    expect(ghost.left).toBeCloseTo(content.left + content.width / 2, 0);
    expect(ghost.width).toBeCloseTo(content.width / 2, 0);
    expect(ghost.height).toBeCloseTo(content.height, 0);
    pointer(document, "pointerup", target);

    const left = screen.getByRole("region", { name: "Left pane" });
    const right = screen.getByRole("region", { name: "Right pane" });
    await expect.element(right.getByRole("button", { name: "b.ts", exact: true })).toBeVisible();
    await expect.element(left.getByTestId("surface file:a.ts")).toBeVisible();
    await expect.element(right.getByTestId("surface file:b.ts")).toBeVisible();
    expect(left.getByRole("button", { name: "b.ts", exact: true }).query()).toBeNull();
    expect(thread().activeSurfaceId).toBe("file:b.ts");
    expect(document.querySelector("[data-right-panel-drop-ghost]")).toBeNull();
    expect(document.querySelector("[data-right-panel-drag-shield]")).toBeNull();
  });

  it("cancels a drag on Escape and leaves the layout as it was", async () => {
    await page.viewport(1280, 800);
    setup({ isOpen: true, activeSurfaceId: "file:a.ts", surfaces: [file("a.ts"), file("b.ts")] });
    await using screen = await render(<Panel width={600} onRender={() => {}} />);

    const { target } = await dragIntoRightThird(screen, "b.ts");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(document.querySelector("[data-right-panel-drop-ghost]")).toBeNull();
      expect(document.querySelector("[data-right-panel-drag-shield]")).toBeNull();
    });
    pointer(document, "pointerup", target);

    expect(thread().split).toBeUndefined();
    expect(thread().surfaces.map((surface) => surface.id)).toEqual(["file:a.ts", "file:b.ts"]);
    expect(screen.getByRole("region", { name: "Right pane" }).query()).toBeNull();
  });

  it("resizes the panes from the splitter without rendering the surfaces until release", async () => {
    await page.viewport(1280, 800);
    setup({
      isOpen: true,
      activeSurfaceId: "file:a.ts",
      surfaces: [file("a.ts"), file("b.ts")],
      split: { rightIds: ["file:b.ts"], otherShownId: "file:b.ts", ratio: 0.5 },
    });
    const onRender = vi.fn();
    await using screen = await render(<Panel width={600} onRender={onRender} />);
    const left = screen.getByRole("region", { name: "Left pane" }).element();
    const handle = screen.getByRole("separator", { name: "Resize split panes" }).element();
    const row = left.closest("[data-right-panel-split-row]")!.getBoundingClientRect();
    const startWidth = left.getBoundingClientRect().width;
    const rendersBefore = onRender.mock.calls.length;
    // Synthetic drag events have no active browser pointer to capture.
    using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});

    const start = center(handle);
    pointer(handle, "pointerdown", start);
    pointer(handle, "pointermove", { x: start.x - 60, y: start.y });
    await vi.waitFor(() => {
      expect(left.getBoundingClientRect().width).toBeCloseTo(startWidth - 60, 0);
    });
    expect(onRender.mock.calls.length).toBe(rendersBefore);

    pointer(handle, "pointerup", { x: start.x - 60, y: start.y });
    await vi.waitFor(() => {
      expect(thread().split?.ratio).toBeCloseTo((startWidth - 60) / row.width, 3);
    });
  });

  it("steps the splitter by keyboard from where the divider is drawn", async () => {
    await page.viewport(1280, 800);
    setup({
      isOpen: true,
      activeSurfaceId: "file:a.ts",
      surfaces: [file("a.ts"), file("b.ts")],
      split: { rightIds: ["file:b.ts"], otherShownId: "file:b.ts", ratio: 0.2 },
    });
    await using screen = await render(<Panel width={600} onRender={() => {}} />);
    const left = screen.getByRole("region", { name: "Left pane" }).element();
    const row = left.closest("[data-right-panel-split-row]")!.getBoundingClientRect();
    const drawn = left.getBoundingClientRect().width;
    expect(drawn).toBeGreaterThan(0.2 * row.width);

    screen.getByRole("separator", { name: "Resize split panes" }).element().focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(thread().split?.ratio).toBeCloseTo((drawn + 16) / row.width, 3);
  });

  it.each([
    ["a background tab", "b.ts"],
    ["the tab the pane already shows", "a.ts"],
  ])(
    "moves focus into the pane on a press of %s and keeps it active there",
    async (_case, name) => {
      await page.viewport(1280, 800);
      setup({
        isOpen: true,
        activeSurfaceId: TERMINAL.id,
        surfaces: [TERMINAL, file("a.ts"), file("b.ts")],
        split: { rightIds: ["file:a.ts", "file:b.ts"], otherShownId: "file:a.ts", ratio: 0.5 },
      });
      await using screen = await render(<Panel width={600} onRender={() => {}} />);
      using _focus = { [Symbol.dispose]: startWorkspaceFocus(screen.router!) };
      const right = screen.getByRole("region", { name: "Right pane" });
      screen.getByRole("textbox", { name: "Terminal input" }).element().focus();

      await userEvent.click(right.getByRole("button", { name, exact: true }));

      await vi.waitFor(() => {
        expect(right.element().contains(document.activeElement)).toBe(true);
      });
      expect(thread().activeSurfaceId).toBe(`file:${name}`);
      expect(thread().split?.otherShownId).toBe(TERMINAL.id);
    },
  );

  it("shows a hidden split as one strip whose Close others closes every other visible tab", async () => {
    await page.viewport(1280, 800);
    setup({
      isOpen: true,
      activeSurfaceId: "file:a.ts",
      surfaces: ["a.ts", "b.ts", "c.ts", "d.ts"].map(file),
      split: { rightIds: ["file:c.ts", "file:d.ts"], otherShownId: "file:c.ts", ratio: 0.5 },
    });
    await using screen = await render(<Panel width={400} onRender={() => {}} />);
    expect(screen.getByRole("region", { name: "Right pane" }).query()).toBeNull();
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
    }

    await userEvent.click(screen.getByRole("button", { name: "a.ts", exact: true }), {
      button: "right",
    });
    await expect.element(page.getByRole("menuitem", { name: "Unsplit" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Move to the right pane" }).query()).toBeNull();
    await page.getByRole("menuitem", { name: "Close others" }).click();

    await vi.waitFor(() => {
      expect(thread().surfaces.map((surface) => surface.id)).toEqual(["file:a.ts"]);
    });
    expect(thread().split).toBeUndefined();
  });
});
