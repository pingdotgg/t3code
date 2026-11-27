import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DeviceServiceState,
  type EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import {
  type PreviewMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "../../previewStateStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deviceEnvironment } from "../../state/device";
import { ChatCanvas } from "../chat/ChatCanvas";
import { createChatCanvasStore } from "../chat/canvasStore";
import { deviceStreamScreenAtom } from "../device/deviceStreamSession";
import { acquireBrowserSurface } from "../../browser/browserSurfaceStore";
import { PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX } from "./previewMiniPlayerLayout";
import { ThreadPreviewMiniPlayer, useThreadPreviewCanvasSource } from "./ThreadPreviewMiniPlayer";

vi.mock(import("../device/DeviceStreamView"), () => ({
  DeviceStreamView: (({ viewId }: { viewId: string }) => (
    <div data-testid="stream" data-view-id={viewId} />
  )) as never,
}));

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const defaultThreadRef = threadRef;
const phone: PreviewMiniPlayerSource = {
  kind: "device",
  hostId: "local",
  deviceId: "phone",
  platform: "ios",
  name: "Phone",
};

function Harness({ threadRef = defaultThreadRef }: { readonly threadRef?: ScopedThreadRef }) {
  const [store] = useState(createChatCanvasStore);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const preview = useThreadPreviewCanvasSource(threadRef, miniPlayer);
  return (
    <ChatCanvas
      store={store}
      rightPanelOpen={false}
      threadRef={threadRef}
      preview={preview}
      composerOverlayElement={null}
    >
      {miniPlayer ? (
        <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} />
      ) : null}
    </ChatCanvas>
  );
}

it("holds its frame through a source change and stops when the gesture is interrupted", async () => {
  using _state = vi
    .spyOn(deviceEnvironment, "state")
    .mockReturnValue(Atom.make<AsyncResult.AsyncResult<DeviceServiceState>>(AsyncResult.initial()));
  using _store = {
    [Symbol.dispose]: () => usePreviewMiniPlayerStore.getState().removeThread(threadRef),
  };
  usePreviewMiniPlayerStore.getState().open(threadRef, phone);
  const container = document.createElement("div");
  container.style.cssText = "display:flex;position:fixed;inset:0;width:1200px;height:800px";
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Harness />
    </RegistryContext.Provider>,
    { container },
  );
  const player = screen.container.querySelector<HTMLElement>("[data-preview-mini-player]")!;
  const handle = (direction: string) =>
    player.querySelector<HTMLElement>(`[data-preview-mini-player-resize="${direction}"]`)!;
  const rect = () => {
    const { left, top, right, bottom } = player.getBoundingClientRect();
    return { left, top, right, bottom };
  };
  const point = (target: HTMLElement, type: string, x: number, y: number, buttons: number) =>
    act(() =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: type === "pointermove" ? -1 : 0,
          buttons,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  const viewId = screen.getByTestId("stream").element().getAttribute("data-view-id")!;
  const portrait = rect();

  // Held without moving while the device rotates: the frame waits for the release.
  await point(handle("northwest"), "pointerdown", portrait.left, portrait.top, 1);
  await act(() =>
    appAtomRegistry.set(deviceStreamScreenAtom(viewId), {
      width: 1_000,
      height: 2_000,
      orientation: "landscape_left",
    }),
  );
  expect(rect()).toEqual(portrait);

  // The release never arrived, so the next buttonless move ends the gesture where it was held.
  await point(handle("northwest"), "pointermove", portrait.left - 200, portrait.top - 200, 0);
  const landscape = rect();
  expect({ right: landscape.right, bottom: landscape.bottom }).toEqual({
    right: portrait.right,
    bottom: portrait.bottom,
  });
  expect(landscape.right - landscape.left).toBe(2 * (landscape.bottom - landscape.top));
  await point(handle("northwest"), "pointermove", portrait.left - 300, portrait.top - 300, 1);
  expect(rect()).toEqual(landscape);

  await point(handle("west"), "pointerdown", landscape.left, landscape.top + 10, 1);
  await act(() => window.dispatchEvent(new Event("blur")));
  await point(handle("west"), "pointermove", landscape.left - 100, landscape.top + 10, 1);
  expect(rect()).toEqual(landscape);
});

it("keeps a desktop browser's controls above its hosted webview from inside an isolated pane", async () => {
  using _preview = { [Symbol.dispose]: resetPreviewStateForTests };
  using _store = {
    [Symbol.dispose]: () => usePreviewMiniPlayerStore.getState().removeThread(threadRef),
  };
  applyPreviewServerSnapshot(threadRef, {
    threadId: "thread-1",
    tabId: "tab-1",
    runtime: "desktop",
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-11-17T00:00:00.000Z",
  });
  usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "browser", tabId: "tab-1" });
  const clipBox = document.createElement("div");
  clipBox.style.cssText = "position:fixed;inset:0;overflow:hidden;border-radius:16px";
  document.body.append(clipBox);
  using _clipBox = { [Symbol.dispose]: () => clipBox.remove() };
  const isolatedPane = document.createElement("div");
  isolatedPane.style.cssText =
    "display:flex;position:absolute;top:0;left:0;width:100%;height:100%;isolation:isolate";
  clipBox.append(isolatedPane);
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Harness />
    </RegistryContext.Provider>,
    { container: isolatedPane },
  );
  const claimPaneFocus = vi.fn();
  isolatedPane.addEventListener("pointerdown", claimPaneFocus);
  const hostedWebviewWrapper = document.createElement("div");
  hostedWebviewWrapper.style.cssText = `position:fixed;inset:0;z-index:${PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}`;
  document.body.append(hostedWebviewWrapper);
  using _hostedWebviewWrapper = { [Symbol.dispose]: () => hostedWebviewWrapper.remove() };

  const close = page.getByRole("button", { name: "Close floating preview" }).element();
  const handle = close.parentElement!.parentElement!;
  const player = isolatedPane.querySelector("[data-preview-mini-player]")!.getBoundingClientRect();
  const dot = handle.getBoundingClientRect();
  expect([dot.left > player.left, dot.right < player.right]).toEqual([true, true]);
  expect([dot.top > player.top, dot.bottom < player.bottom]).toEqual([true, true]);
  const hit = (target: Element) => {
    const { left, top, width, height } = target.getBoundingClientRect();
    return document.elementFromPoint(left + width / 2, top + height / 2);
  };
  expect(handle.contains(hit(handle))).toBe(true);
  // Clipping the pane's left edge must not clip outer halves of unclipped resize handles.
  isolatedPane.style.left = `${-(player.left + 20)}px`;
  await act(() => window.dispatchEvent(new Event("resize")));
  await vi.waitFor(() => {
    const clipped = isolatedPane
      .querySelector("[data-preview-mini-player]")!
      .getBoundingClientRect();
    const north = document.elementFromPoint(clipped.right - 20, clipped.top - 2);
    expect(north?.getAttribute("data-preview-mini-player-resize")).toBe("north");
    const east = document.elementFromPoint(clipped.right + 2, clipped.top + clipped.height / 2);
    expect(east?.getAttribute("data-preview-mini-player-resize")).toBe("east");
    const south = document.elementFromPoint(clipped.right - 20, clipped.bottom + 2);
    expect(south?.getAttribute("data-preview-mini-player-resize")).toBe("south");
  });
  isolatedPane.style.left = "0";
  await act(() => window.dispatchEvent(new Event("resize")));

  // While another slot owns the tab and this slot is not shown, portaled controls still follow moves.
  const runtimeTabId = isolatedPane
    .querySelector("[data-browser-surface-slot]")!
    .getAttribute("data-browser-surface-slot")!;
  const otherLease = acquireBrowserSurface(runtimeTabId);
  using _otherLease = { [Symbol.dispose]: () => otherLease.release() };
  await act(() =>
    usePreviewMiniPlayerStore.getState().move(threadRef, "browser:tab-1", { x: 24, y: 24 }),
  );
  await vi.waitFor(() => {
    const movedPlayer = isolatedPane
      .querySelector("[data-preview-mini-player]")!
      .getBoundingClientRect();
    const movedPortal = handle.parentElement!.parentElement!.getBoundingClientRect();
    expect(Math.abs(movedPortal.left - movedPlayer.left)).toBeLessThan(1);
    expect(Math.abs(movedPortal.top - movedPlayer.top)).toBeLessThan(1);
  });
  otherLease.release();

  // Portaled controls keep a labelled region and become inert when an ancestor hides the slot.
  const portalLayer = handle.parentElement!.parentElement!;
  const playerHost = isolatedPane.querySelector("[data-preview-mini-player]")!.parentElement!;
  expect(portalLayer.getAttribute("role")).toBe("region");
  expect(portalLayer.getAttribute("aria-label")).toBe("Floating browser preview");
  playerHost.style.display = "none";
  await act(() => window.dispatchEvent(new Event("resize")));
  await vi.waitFor(() => expect(portalLayer.inert).toBe(true));
  playerHost.style.display = "";
  await act(() => window.dispatchEvent(new Event("resize")));
  await vi.waitFor(() => expect(portalLayer.inert).toBe(false));

  // Touch: tapping the handle toggles the pill closed, and pressing a pill button keeps it open.
  using _capture = vi
    .spyOn(HTMLElement.prototype, "setPointerCapture")
    .mockImplementation(() => {});
  const touchTap = async (target: Element) => {
    const { left, top, width, height } = target.getBoundingClientRect();
    const init = {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: left + width / 2,
      clientY: top + height / 2,
      bubbles: true,
      cancelable: true,
    };
    await act(() => {
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      target.dispatchEvent(new MouseEvent("click", init));
    });
  };
  await touchTap(handle);
  expect(handle.hasAttribute("data-pill-open")).toBe(true);
  await touchTap(handle);
  expect(handle.hasAttribute("data-pill-open")).toBe(false);
  await touchTap(handle);
  expect(handle.hasAttribute("data-pill-open")).toBe(true);
  await act(() =>
    close.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        buttons: 1,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(handle.hasAttribute("data-pill-open")).toBe(true);
  claimPaneFocus.mockClear();

  await act(() => (close as HTMLElement).focus());
  expect(close.contains(hit(close))).toBe(true);
  await page.getByRole("button", { name: "Close floating preview" }).click();
  expect(claimPaneFocus).toHaveBeenCalledOnce();
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
  ).toBeNull();
});

it("keeps one stream when switching between threads floating the same device", async () => {
  using _state = vi
    .spyOn(deviceEnvironment, "state")
    .mockReturnValue(Atom.make<AsyncResult.AsyncResult<DeviceServiceState>>(AsyncResult.initial()));
  const otherThreadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2"));
  using _store = {
    [Symbol.dispose]: () => {
      usePreviewMiniPlayerStore.getState().removeThread(threadRef);
      usePreviewMiniPlayerStore.getState().removeThread(otherThreadRef);
    },
  };
  usePreviewMiniPlayerStore.getState().open(threadRef, phone);
  usePreviewMiniPlayerStore.getState().open(otherThreadRef, phone);
  const harness = (ref: ScopedThreadRef) => (
    <RegistryContext.Provider value={appAtomRegistry}>
      <Harness threadRef={ref} />
    </RegistryContext.Provider>
  );
  const container = document.createElement("div");
  container.style.cssText = "display:flex;position:fixed;inset:0;width:1200px;height:800px";
  await using screen = await render(harness(threadRef), { container });
  const viewId = () => screen.getByTestId("stream").element().getAttribute("data-view-id");
  const first = viewId();

  // The stream session is keyed by view, so a new view id reconnects the device.
  await screen.rerender(harness(otherThreadRef));
  expect(viewId()).toBe(first);
});
