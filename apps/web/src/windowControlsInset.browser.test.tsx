import { expect, it, vi } from "vite-plus/test";

import { render } from "../test/render";
import { useWindowControlsInsetStyle } from "./windowControlsInset";

vi.mock("./env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./env")>()),
  isElectron: true,
}));

function windowedMacosDesktop() {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const bridge = {
    getWindowFullscreenState: vi.fn(() => false),
    onWindowFullscreenStateChange: vi.fn((_listener: (fullscreen: boolean) => void) => () => {}),
  };
  Object.assign(window, { desktopBridge: bridge });
  return {
    bridge,
    [Symbol.dispose]() {
      platform.mockRestore();
      Reflect.deleteProperty(window, "desktopBridge");
    },
  };
}

function Inset(props: { readonly id: string }) {
  return <div data-testid={props.id} style={useWindowControlsInsetStyle()} />;
}

it("reads the fullscreen state once while any surface stays subscribed", async () => {
  using desktop = windowedMacosDesktop();
  await using screen = await render(
    <>
      <Inset id="layout" />
      <Inset id="sheet" />
    </>,
    { router: false },
  );
  await screen.rerender(<Inset id="layout" />);
  const readsAfterSheetCloses = desktop.bridge.getWindowFullscreenState.mock.calls.length;

  await screen.rerender(<Inset id="layout" />);

  expect(desktop.bridge.getWindowFullscreenState).toHaveBeenCalledTimes(readsAfterSheetCloses);
  expect(
    screen.getByTestId("layout").element().style.getPropertyValue("--workspace-controls-left"),
  ).toBe("var(--desktop-window-controls-inset, 90px)");
});

it("reads the fullscreen state again after every surface unsubscribes", async () => {
  using desktop = windowedMacosDesktop();
  await using first = await render(<Inset id="first" />, { router: false });
  await first.unmount();
  const readsBeforeRemount = desktop.bridge.getWindowFullscreenState.mock.calls.length;

  await using _second = await render(<Inset id="second" />, { router: false });

  expect(desktop.bridge.getWindowFullscreenState.mock.calls.length).toBeGreaterThan(
    readsBeforeRemount,
  );
});
