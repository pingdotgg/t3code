import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

import { AppSidebarLayout } from "./AppSidebarLayout";

async function renderMacosDesktopLayout({ fullscreen }: { fullscreen: boolean }) {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"));
  const listeners = new Set<(fullscreen: boolean) => void>();
  stack.use(
    stubGlobal("desktopBridge", {
      getWindowFullscreenState: () => fullscreen,
      onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onMenuAction: () => () => {},
      getClientSettings: async () => null,
      getLocalEnvironmentBootstraps: () => [],
    }),
  );
  const screen = stack.use(
    await render(
      <AppSidebarLayout>
        <header className="drag-region" data-testid="titlebar" />
      </AppSidebarLayout>,
    ),
  );
  const environment = stack.move();
  return {
    appRegion: () =>
      getComputedStyle(screen.getByTestId("titlebar").element()).getPropertyValue(
        "-webkit-app-region",
      ),
    setFullscreen: (next: boolean) =>
      act(() => {
        for (const listener of listeners) listener(next);
      }),
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

// regression: #19079
describe("window drag regions on macOS desktop", () => {
  // A fullscreen window cannot move, and Electron sends a stray pointermove after a press
  // inside a drag region, which starts a tab drag and swallows the click.
  it("are off in native fullscreen and back after leaving it", async () => {
    await using layout = await renderMacosDesktopLayout({ fullscreen: true });

    expect(layout.appRegion(), "titlebar in native fullscreen").not.toBe("drag");

    await layout.setFullscreen(false);

    expect(layout.appRegion(), "titlebar after leaving native fullscreen").toBe("drag");
  });
});
