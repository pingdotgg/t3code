import "../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

/** The alpha of a computed color, whatever color syntax the browser serializes it in. */
function alphaOf(color: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return (context.getImageData(0, 0, 1, 1).data[3] ?? 0) / 255;
}

/** The root classes of the macOS desktop app, removed again when the test ends. */
function macDesktopRoot(dark: boolean): Disposable {
  const root = document.documentElement.classList;
  const classes = (dark ? ["electron-macos", "dark"] : ["electron-macos"]).filter(
    (name) => !root.contains(name),
  );
  root.add(...classes);
  return { [Symbol.dispose]: () => root.remove(...classes) };
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

  // The macOS window glass thins the window frame (--shell-fill) to 60%. The modal floats over
  // the app, so a bright browser page behind it must not tint its shell, and its backdrop must
  // calm that page like the rest of the window.
  it.each([false, true])(
    "keeps the shell nearly opaque over the macOS glass (dark: %s)",
    async (dark) => {
      using _root = macDesktopRoot(dark);
      await using _screen = await render(<AppRouteModal label="Orbit">content</AppRouteModal>, {
        router: "/settings/general",
      });

      const popup = document.querySelector<HTMLElement>("[data-app-modal]");
      const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
      expect(popup).not.toBeNull();
      expect(backdrop).not.toBeNull();

      const shell = getComputedStyle(popup!);
      expect(alphaOf(shell.backgroundColor)).toBeGreaterThanOrEqual(0.9);
      // The frame's own blur stays as it was.
      expect(shell.backdropFilter).toContain("blur(40px)");

      expect(backdrop!.classList).toContain("app-modal-backdrop");
      const behind = getComputedStyle(backdrop!);
      expect(alphaOf(behind.backgroundColor)).toBeGreaterThanOrEqual(0.75);
      expect(behind.backdropFilter).toMatch(/blur\(1[26]px\)/);
    },
  );
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
});
