import { assert, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";
import { render, stubGlobal } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));
// The fullscreen state comes from the desktop bridge, which only the desktop app reads.
vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isElectron: true,
}));

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("returns focus to the opener when Esc closes it", async () => {
    const opener = <button type="button">Open usage</button>;
    await using screen = await render(opener, { router: "/" });
    const openerButton = screen.getByRole("button", { name: "Open usage" });
    (openerButton.element() as HTMLElement).focus();

    await screen.rerender(
      <>
        {opener}
        <AppRouteModal label="Usage">
          <p>Usage</p>
        </AppRouteModal>
      </>,
    );
    await expect.element(page.getByRole("dialog", { name: "Usage" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    await expect.element(openerButton).toHaveFocus();
  });

  it("stays open when Esc belongs to a modal outside Base UI", async () => {
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={() => undefined} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    // Base UI takes initial focus a frame after opening; let it land before Clerk's modal takes focus.
    await expect.element(settings).toHaveFocus();
    // Clerk renders its account modal in its own root and dismisses on a document Esc listener.
    const foreignModal = document.body.appendChild(document.createElement("input"));
    using _foreignModal = { [Symbol.dispose]: () => foreignModal.remove() };

    foreignModal.focus();
    await userEvent.keyboard("{Escape}");

    await expect.element(settings).toHaveAttribute("data-open");
  });

  it("keeps the title bar above the popup draggable at desktop width", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    // A desktop window's native caption strip, as the window controls overlay reports it.
    Object.defineProperty(navigator, "windowControlsOverlay", {
      configurable: true,
      value: {
        visible: true,
        getTitlebarAreaRect: () => new DOMRect(0, 0, 1280, 52),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    using _overlay = {
      [Symbol.dispose]: () => Reflect.deleteProperty(navigator, "windowControlsOverlay"),
    };
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <p>Settings</p>
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect.element(settings).toHaveFocus();

    const strip = document.elementFromPoint(window.innerWidth / 2, 20);
    assert(strip instanceof HTMLElement);
    expect(settings.element().contains(strip)).toBe(false);
    expect(getComputedStyle(strip).getPropertyValue("-webkit-app-region")).toBe("drag");
    expect(strip.getBoundingClientRect()).toMatchObject({ top: 0, height: 52 });
  });

  it("leaves the title bar as backdrop in macOS fullscreen", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    using _platform = { [Symbol.dispose]: () => Reflect.deleteProperty(navigator, "platform") };
    using _bridge = stubGlobal("desktopBridge", {
      getWindowFullscreenState: () => true,
      onWindowFullscreenStateChange: () => () => undefined,
    });
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <p>Settings</p>
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect.element(settings).toHaveFocus();

    const band = document.elementFromPoint(window.innerWidth / 2, 20);
    assert(band instanceof HTMLElement);
    expect(getComputedStyle(band).getPropertyValue("-webkit-app-region")).toBe("no-drag");
    await userEvent.click(page.elementLocator(band), {
      position: { x: window.innerWidth / 2, y: 20 },
    });
    await expect.element(settings).not.toBeInTheDocument();
  });
});
