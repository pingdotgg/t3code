import { assert, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";
import { render, stubGlobal } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

// A desktop window's native caption strip, as the window controls overlay reports it.
function stubCaptionStrip(): Disposable {
  Object.defineProperty(navigator, "windowControlsOverlay", {
    configurable: true,
    value: {
      visible: true,
      getTitlebarAreaRect: () => new DOMRect(0, 0, 1100, 40),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  return { [Symbol.dispose]: () => Reflect.deleteProperty(navigator, "windowControlsOverlay") };
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

  it("dismisses on a click in the titlebar band and moves the window on a drag there", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1100, 780);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    using _overlay = stubCaptionStrip();
    const dragWindow = vi.fn(async () => true);
    using _bridge = stubGlobal("desktopBridge", { dragWindow });
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <p>Settings</p>
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect.element(settings).toHaveFocus();
    const band = document.elementFromPoint(220, 20);
    assert(band instanceof HTMLElement);
    const backdrop = page.elementLocator(band);

    await userEvent.dragAndDrop(backdrop, backdrop, {
      sourcePosition: { x: 220, y: 20 },
      targetPosition: { x: 260, y: 24 },
    });
    expect(dragWindow.mock.calls[0]).toEqual(["start"]);
    expect(dragWindow.mock.calls.slice(1)).toContainEqual(["move"]);
    await expect.element(settings).toHaveAttribute("data-open");

    await userEvent.click(backdrop, { position: { x: 220, y: 20 } });
    await expect.element(settings).not.toBeInTheDocument();
  });

  it("leaves the titlebar band to a drag region where the page cannot move the window", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1100, 780);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    using _overlay = stubCaptionStrip();
    // The desktop shell on Wayland: a bridge without `dragWindow`.
    using _bridge = stubGlobal("desktopBridge", {});
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <p>Settings</p>
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect.element(settings).toHaveFocus();

    const band = document.elementFromPoint(220, 20);
    assert(band instanceof HTMLElement);
    expect(settings.element().contains(band)).toBe(false);
    expect(getComputedStyle(band).getPropertyValue("-webkit-app-region")).toBe("drag");
    expect(band.getBoundingClientRect()).toMatchObject({ top: 0, height: 40 });
  });
});
