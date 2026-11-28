import "~/index.css";

import { redirect, useLocation } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

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

  // regression: #42075. Navigation: Back (mod+[) leaves the Settings route without closing the dialog.
  it("commits a focused field when the route goes back", async () => {
    const onCommit = vi.fn();
    function SettingsRoute() {
      const pathname = useLocation({ select: (location) => location.pathname });
      return pathname.startsWith("/settings") ? (
        <AppRouteModal label="Settings">
          <CommitOnBlurField onCommit={onCommit} />
        </AppRouteModal>
      ) : null;
    }
    await using screen = await render(<SettingsRoute />, { router: "/" });
    // The app redirects /settings, and the router skips onBeforeNavigate after a redirect.
    screen.router!.routeTree.update({
      beforeLoad: ({ location }: { location: { pathname: string } }) => {
        if (location.pathname === "/settings") throw redirect({ to: "/settings/general" });
      },
    });
    await screen.router!.navigate({ to: "/settings" });

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    screen.router!.history.back();

    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
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

  it("stays open when a held Esc repeats after closing a nested menu", async () => {
    await using _screen = await render(
      <AppRouteModal label="Usage">
        <Menu>
          <MenuTrigger>All providers</MenuTrigger>
          <MenuPopup>
            <MenuItem>Claude</MenuItem>
          </MenuPopup>
        </Menu>
      </AppRouteModal>,
      { router: "/usage" },
    );
    const usage = page.getByRole("dialog", { name: "Usage" });
    const trigger = page.getByRole("button", { name: "All providers" });
    await expect.element(usage).toHaveFocus();

    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await expect.element(usage).toHaveAttribute("data-open");

    await act(() =>
      trigger.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect.element(usage).toHaveAttribute("data-open");

    await userEvent.keyboard("{Escape}");
    await expect.element(usage).not.toBeInTheDocument();
  });

  // regression: #45028. A press and release on different elements click their common ancestor.
  it("stays open when a press on the backdrop is released inside the window", async () => {
    const size = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(size.width, size.height),
    };
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <input aria-label="Instructions" />
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect.element(settings).toHaveAttribute("data-open");

    await userEvent.hover(settings.element().parentElement!, { position: { x: 4, y: 4 } });
    await commands.pointerDown();
    try {
      await userEvent.hover(page.getByRole("textbox", { name: "Instructions" }));
    } finally {
      await commands.pointerUp();
    }
    await act(async () => {});

    expect(settings.element()).toHaveAttribute("data-open");
  });
});
