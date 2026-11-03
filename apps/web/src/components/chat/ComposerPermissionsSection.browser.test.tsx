import type { RuntimeMode } from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import {
  focusRequestedPermission,
  markOpenToPermissions,
  useComposerMenuProps,
} from "./composerEventScope";
import { ComposerFooterModeControls, ComposerPermissionsSection } from "./ComposerFooterControls";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";

const options = runtimeModeOptions.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));

// Mirrors the overflow menu: mode radio items first, then the Permissions section.
function OverflowMenu() {
  const [interaction, setInteraction] = useState("plan");
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  const composerMenuProps = useComposerMenuProps();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Menu onOpenChangeComplete={(open) => focusRequestedPermission(open, triggerRef.current)}>
        <MenuTrigger ref={triggerRef}>More</MenuTrigger>
        <MenuPopup {...composerMenuProps}>
          <MenuRadioGroup value={interaction} onValueChange={setInteraction}>
            <MenuRadioItem value="default">Chat</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
          <ComposerPermissionsSection
            runtimeMode={mode}
            runtimeModeOptions={options}
            onRuntimeModeChange={setMode}
          />
        </MenuPopup>
      </Menu>
      <p role="status">{mode}</p>
    </>
  );
}

it("reaches Permissions from the mode items with arrow keys, previews, and picks with Enter", async () => {
  await using screen = await render(<OverflowMenu />, { router: false }); // no routes involved
  const trigger = screen.getByRole("button", { name: "More" });
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitemradio", { name: "Chat" })).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  const supervised = page.getByRole("menuitemradio", { name: "Supervised" });
  await expect.element(supervised).toHaveFocus();
  await expect
    .element(supervised)
    .toHaveAccessibleDescription("Ask before commands and file changes.");

  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Auto-accept edits" }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio", { name: "Supervised" })).toHaveFocus();

  await userEvent.keyboard("{ArrowUp}");
  await expect.element(page.getByRole("menuitemradio", { name: "Plan" })).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await expect.element(screen.getByRole("status")).toHaveTextContent("auto-accept-edits");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Supervised" }))
    .not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("marks the current mode as checked and closes on Escape", async () => {
  await using screen = await render(<OverflowMenu />, { router: false }); // no routes involved
  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  const fullAccess = page.getByRole("menuitemradio", { name: "Full access" });
  await expect.element(fullAccess).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(fullAccess).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "More" })).toHaveFocus();
});

// The real composer menu focus rule (useComposerMenuProps), with a stub composer handle.
function withComposer(children: ReactNode) {
  const handle = { focusAtEnd: vi.fn() };
  const ref = { current: handle } as unknown as ComposerHandleRef;
  return { handle, ui: <ComposerHandleContext value={ref}>{children}</ComposerHandleContext> };
}

it("returns focus to the editor after a pick", async () => {
  const { handle, ui } = withComposer(<OverflowMenu />);
  await using screen = await render(ui, { router: false }); // no routes involved
  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitemradio", { name: "Chat" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await expect.element(screen.getByRole("status")).toHaveTextContent("approval-required");
  await vi.waitFor(() => expect(handle.focusAtEnd).toHaveBeenCalled());
});

it("opens on the checked permission when composer.mode marked the trigger", async () => {
  await using screen = await render(<OverflowMenu />, { router: false }); // no routes involved
  const trigger = screen.getByRole("button", { name: "More" });
  markOpenToPermissions(trigger.element() as HTMLElement);
  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitemradio", { name: "Full access" })).toHaveFocus();

  // The mark is used once: a plain reopen lands on the menu's usual first focus.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitemradio", { name: "Full access" })).not.toHaveFocus();
});

// Mirrors ComposerControlsBar: the chip shows only while the mode differs from the default.
function PermissionsChip() {
  const [mode, setMode] = useState<RuntimeMode>("approval-required");
  return (
    <div data-slot="composer-shell">
      <button type="button" data-composer-shortcut="composer.effort composer.mode">
        Model
      </button>
      {mode === "full-access" ? null : (
        <ComposerFooterModeControls
          showInteractionModeToggle={false}
          interactionMode="default"
          runtimeMode={mode}
          runtimeModeOptions={options}
          accessDisplay="label"
          onToggleInteractionMode={() => {}}
          onRuntimeModeChange={setMode}
        />
      )}
    </div>
  );
}

it("returns focus to the editor when picking the default hides the chip", async () => {
  const { handle, ui } = withComposer(<PermissionsChip />);
  await using screen = await render(ui, { router: false }); // no routes involved
  await userEvent.click(screen.getByRole("button", { name: "Permissions: Supervised" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Full access" }));
  await vi.waitFor(() => expect(handle.focusAtEnd).toHaveBeenCalled());
  await expect.element(screen.getByRole("button", { name: "Model" })).not.toHaveFocus();
});
