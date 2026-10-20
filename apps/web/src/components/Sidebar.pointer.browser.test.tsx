import type { SensorProps } from "@dnd-kit/core";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { dismissContextMenu } from "../contextMenuFallback";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import { SidebarProvider } from "./ui/sidebar";
import "../index.css";

const sensors: SidebarPointerSensor[] = [];
let hidden = false;

function pointer(type: string, values: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture(
  extraOptions: Partial<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]> = {},
) {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish, ...extraOptions },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, ...callbacks };
}

describe("sidebar pointer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  });
  afterEach(() => {
    for (const sensor of sensors.splice(0)) sensor.cancel();
    // Cancelled sensors keep suppressing clicks on the shared document until the next press.
    document.dispatchEvent(pointer("pointerdown"));
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a click idle and starts only after the drag threshold", () => {
    const click = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 16 }));
    expect(click.onStart).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(click.onAbort).toHaveBeenCalledOnce();
    expect(click.onFinish).toHaveBeenCalledOnce();

    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 17 }));
    expect(drag.onStart).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 10 });
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(drag.onEnd).toHaveBeenCalledOnce();
    expect(drag.onAbort).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("moves to the pointer on the move that starts the drag", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 90 }));
    expect(drag.onStart).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 10 });
    expect(drag.onMove).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 90 });
  });

  const interruptions = {
    blur: () => window.dispatchEvent(new Event("blur")),
    hidden: () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    pagehide: () => window.dispatchEvent(new Event("pagehide")),
    resize: () => window.dispatchEvent(new Event("resize")),
    escape: () => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" })),
    pointercancel: () => document.dispatchEvent(pointer("pointercancel")),
    "missed release": () =>
      document.dispatchEvent(pointer("pointermove", { buttons: 0, clientY: 100 })),
  };
  for (const [name, interrupt] of Object.entries(interruptions)) {
    it.each([false, true])(`cancels on ${name}, started=%s, and ignores late events`, (started) => {
      const drag = gesture();
      if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
      interrupt();
      document.dispatchEvent(pointer("pointermove", { clientY: 100 }));
      document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      drag.sensor.cancel();
      expect(drag.onCancel).toHaveBeenCalledOnce();
      expect(drag.onEnd).not.toHaveBeenCalled();
      expect(drag.onFinish).toHaveBeenCalledOnce();
      expect(drag.onStart).toHaveBeenCalledTimes(started ? 1 : 0);
      expect(drag.onAbort).toHaveBeenCalledTimes(started ? 0 : 1);

      hidden = false;
      const next = gesture();
      document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
      document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      expect(next.onStart).toHaveBeenCalledOnce();
      expect(next.onEnd).toHaveBeenCalledOnce();
    });
  }

  it("hands claimed moves and drops to the context handlers and cancels the sort", () => {
    const onMove = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 30 }));
    expect(drag.onMove).toHaveBeenNthCalledWith(1, { x: 10, y: 20 });
    expect(drag.onMove).toHaveBeenNthCalledWith(2, { x: 30, y: 30 });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    expect(drag.onMove).toHaveBeenCalledTimes(2);
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 90, clientY: 30 }));
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 90, y: 30 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);

    const inside = gesture({ onMove, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 10, clientY: 20 }));
    expect(inside.onEnd).toHaveBeenCalledOnce();
    expect(inside.onCancel).not.toHaveBeenCalled();
  });

  it("drops context when a zero-button move precedes pointerup", () => {
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));

    // Native desktop releases can report the released button on the final move.
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 100, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 94, y: 32 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cancels a missed sidebar release without committing a reorder", () => {
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 30, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not drop context when the button is released before activation", () => {
    const onDrop = vi.fn(() => true);
    const drag = gesture({ onDrop });
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 90, clientY: 30 }));

    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.onStart).not.toHaveBeenCalled();
    expect(drag.onAbort).toHaveBeenCalledOnce();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("resumes reordering when a context drag returns to the sidebar", () => {
    const drag = gesture({
      onMove: (point) => point.x > 50,
      onDrop: (point) => point.x > 50,
    });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 100 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 200 }));
    expect(drag.onMove).toHaveBeenCalledTimes(2);
    expect(drag.onMove).toHaveBeenLastCalledWith({ x: 30, y: 30 });

    document.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 60 }));
    expect(drag.onMove).toHaveBeenLastCalledWith({ x: 30, y: 60 });
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 60 }));
    expect(drag.onEnd).toHaveBeenCalledOnce();
    expect(drag.onCancel).not.toHaveBeenCalled();
  });

  it.each([false, true])("suppresses a cancelled release click, started=%s", (started) => {
    const drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    drag.sensor.cancel();
    vi.advanceTimersByTime(1000);
    const releaseClick = new Event("click");
    const releasePropagation = vi.spyOn(releaseClick, "stopPropagation");
    document.dispatchEvent(releaseClick);
    expect(releasePropagation).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer("pointerdown"));
    const nextClick = new Event("click");
    const nextPropagation = vi.spyOn(nextClick, "stopPropagation");
    document.dispatchEvent(nextClick);
    expect(nextPropagation).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows a fresh click after an outside release, started=%s", (started) => {
    const drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    drag.sensor.cancel();
    document.dispatchEvent(pointer("pointerdown"));
    const click = new Event("click");
    const propagation = vi.spyOn(click, "stopPropagation");
    document.dispatchEvent(click);
    expect(propagation).not.toHaveBeenCalled();
  });

  it("does not move after cancellation during activation", () => {
    const drag = gesture();
    drag.onStart.mockImplementation(() => drag.sensor.cancel());
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onMove).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("ignores events from other pointers", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { pointerId: 2, buttons: 0, clientY: 100 }));
    document.dispatchEvent(pointer("pointercancel", { pointerId: 2 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 2 }));
    expect(drag.onStart).not.toHaveBeenCalled();
    expect(drag.onFinish).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(drag.onStart).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cancels when search unmounts the list, started=%s", (started) => {
    const root = createRoot(document.createElement("div"));
    let drag: ReturnType<typeof gesture> | undefined;
    act(() =>
      root.render(
        <StrictMode>
          <SidebarDragLifecycle onUnmount={() => drag?.sensor.cancel()} />
        </StrictMode>,
      ),
    );
    drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    act(() => root.unmount());
    document.dispatchEvent(pointer("pointermove", { clientY: 100 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(drag.onStart).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("detaches a cancelled sensor before a replacement gesture starts", () => {
    const previous = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    previous.sensor.cancel();
    const next = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(previous.onCancel).toHaveBeenCalledOnce();
    expect(previous.onEnd).not.toHaveBeenCalled();
    expect(next.onEnd).toHaveBeenCalledOnce();
  });
});

const environmentId = EnvironmentId.make("sidebar-test");
const projects: Project[] = ["Alpha", "Beta"].map((title) => ({
  environmentId,
  id: ProjectId.make(title),
  title,
  workspaceRoot: `/test/${title}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-03-09T10:00:00.000Z",
  updatedAt: "2026-03-09T10:00:00.000Z",
  scripts: [],
}));

const threads = [
  makeThreadFixture({
    environmentId,
    projectId: ProjectId.make("Alpha"),
    title: "Existing thread",
  }),
];

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => projects,
  useThreadShells: () => threads,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

describe("sidebar row controls", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(1280, 800);
    container = document.createElement("div");
    container.style.cssText = "width: 320px; padding: 80px 40px;";
    document.body.append(container);
    root = createRoot(container);
    for (const project of projects) {
      const draftId = DraftId.make(project.title);
      const store = useComposerDraftStore.getState();
      store.setProjectDraftThreadId(scopeProjectRef(environmentId, project.id), draftId);
      store.setPrompt(draftId, "Fix tests");
    }
  });

  afterEach(async () => {
    dismissContextMenu();
    await act(() => root.unmount());
    container.remove();
    for (const project of projects) {
      useComposerDraftStore.getState().clearDraftThread(DraftId.make(project.title));
    }
    vi.unstubAllGlobals();
  });

  async function renderSidebar() {
    const route = createRootRoute({
      component: () => (
        <AppAtomRegistryProvider>
          <SidebarProvider>
            <div className="flex w-full flex-col">
              <Sidebar />
            </div>
          </SidebarProvider>
        </AppAtomRegistryProvider>
      ),
    });
    const router = createRouter({
      routeTree: route.addChildren([
        createRoute({ getParentRoute: () => route, path: "/" }),
        createRoute({ getParentRoute: () => route, path: "/draft/$draftId" }),
        createRoute({ getParentRoute: () => route, path: "/$environmentId/$threadId" }),
      ]),
      history: createMemoryHistory(),
    });
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    return router;
  }

  it("navigates named rows by keyboard and pointer with independently reachable draft actions", async () => {
    const router = await renderSidebar();
    const primary = page.getByRole("button", {
      name: "Fix tests, Unsent draft, Alpha",
      exact: true,
    });
    const other = page.getByRole("button", { name: "Fix tests, Unsent draft, Beta", exact: true });
    await act(() => (primary.element() as HTMLElement).focus());
    await act(() => userEvent.keyboard("{Enter}"));
    expect(router.state.location.pathname).toBe("/draft/Alpha");
    await act(() => (other.element() as HTMLElement).focus());
    await act(() => userEvent.keyboard(" "));
    expect(router.state.location.pathname).toBe("/draft/Beta");

    await act(() => userEvent.tab());
    const discard = document.activeElement!;
    expect(discard).toHaveAccessibleName("Discard draft");
    expect(discard.parentElement?.closest('button, [role="button"]')).toBeNull();
    expect(primary.element()).toBeInstanceOf(HTMLButtonElement);
    expect(other.element()).toBeInstanceOf(HTMLButtonElement);
    await act(() => userEvent.keyboard(" "));
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("Beta"))).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("Alpha"))).not.toBeNull();
    expect(router.state.location.pathname).toBe("/draft/Beta");

    const row = primary.element().closest('[data-testid="sidebar-draft-row"]')!;
    await act(() => page.elementLocator(row).getByText("Fix tests", { exact: true }).click());
    expect(router.state.location.pathname).toBe("/draft/Alpha");
    expect(document.activeElement).toBe(primary.element());

    const thread = page.getByRole("button", { name: /^Existing thread,.*Alpha$/ });
    expect(thread.element()).toBeInstanceOf(HTMLButtonElement);
    await act(() => (thread.element() as HTMLElement).focus());
    await act(() => userEvent.keyboard(" "));
    expect(router.state.location.pathname).toBe("/sidebar-test/thread-test");
  });

  it("opens a draft context menu at the row with keyboard and pointer input", async () => {
    await renderSidebar();
    const primary = page.getByRole("button", {
      name: "Fix tests, Unsent draft, Alpha",
      exact: true,
    });
    const row = primary.element().closest('[data-testid="sidebar-draft-row"]')!;
    const rect = row.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    for (const openMenu of [
      () => userEvent.keyboard("{Shift>}{F10}{/Shift}"),
      () => userEvent.keyboard("{ContextMenu}"),
      () => {
        primary
          .element()
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      },
    ]) {
      await act(() => (primary.element() as HTMLElement).focus());
      await act(openMenu);
      const menu = document.querySelector<HTMLElement>('[data-level="0"]')!;
      expect(menu).not.toBeNull();
      expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(rect.left);
      expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(rect.top);
      expect(menu.getBoundingClientRect().top).toBeLessThanOrEqual(rect.bottom);
      await act(() => userEvent.keyboard("{Escape}"));
      expect(menu.isConnected).toBe(false);
    }
    await act(() => page.elementLocator(row).click({ button: "right" }));
    const pointerMenu = document.querySelector<HTMLElement>('[data-level="0"]')!;
    expect(pointerMenu).not.toBeNull();
    await act(() =>
      page
        .elementLocator(pointerMenu)
        .getByRole("button", { name: "Discard draft", exact: true })
        .click(),
    );
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("Alpha"))).toBeNull();
  });
});
