import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type DeviceServiceState, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  type PreviewMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deviceEnvironment } from "../../state/device";
import { ChatCanvas } from "../chat/ChatCanvas";
import { createChatCanvasStore } from "../chat/canvasStore";
import { deviceStreamScreenAtom } from "../device/deviceStreamSession";
import { ThreadPreviewMiniPlayer, useThreadPreviewCanvasSource } from "./ThreadPreviewMiniPlayer";

vi.mock(import("../device/DeviceStreamView"), () => ({
  DeviceStreamView: (({ viewId }: { viewId: string }) => (
    <div data-testid="stream" data-view-id={viewId} />
  )) as never,
}));

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const phone: PreviewMiniPlayerSource = {
  kind: "device",
  hostId: "local",
  deviceId: "phone",
  platform: "ios",
  name: "Phone",
};

function Harness() {
  const [store] = useState(createChatCanvasStore);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const preview = useThreadPreviewCanvasSource(threadRef, miniPlayer);
  return (
    <ChatCanvas store={store} threadRef={threadRef} preview={preview} composerOverlayElement={null}>
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
