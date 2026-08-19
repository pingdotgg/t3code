import type { Locator, Page } from "playwright";
import { expect } from "vite-plus/test";

/** Stable selectors for the web client. Prefer these over copy that can drift. */
export function composerEditor(page: Page): Locator {
  return page.getByTestId("composer-editor");
}

export function sendMessageButton(page: Page): Locator {
  return page.getByRole("button", { name: "Send message" });
}

export function addProjectButton(page: Page): Locator {
  return page.getByRole("button", { name: "Add project" }).first();
}

export function commandPalette(page: Page): Locator {
  return page.getByTestId("command-palette");
}

export function paletteInput(page: Page): Locator {
  return commandPalette(page).locator("[data-slot=autocomplete-input]");
}

export function slashCommandItem(page: Page, id: string): Locator {
  return page.locator(`[data-composer-item-id="${id}"]`);
}

export function goalChip(page: Page): Locator {
  return page.locator("[data-goal-chip]");
}

export function goalActiveMarker(page: Page): Locator {
  return page.locator("[data-goal-active]");
}

export function toastTitle(page: Page): Locator {
  return page.locator("[data-slot=toast-title]");
}

export function toastDescription(page: Page): Locator {
  return page.locator("[data-slot=toast-description]");
}

export async function canSendMessage(page: Page): Promise<boolean> {
  const send = sendMessageButton(page);
  if ((await send.count()) === 0) {
    return false;
  }
  return !(await send.isDisabled());
}

export async function typeInComposer(page: Page, text: string): Promise<void> {
  const editor = composerEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 15 });
}

export async function submitComposer(page: Page): Promise<void> {
  const send = sendMessageButton(page);
  if ((await send.count()) > 0 && !(await send.isDisabled())) {
    await send.click();
    return;
  }
  await composerEditor(page).press("Enter");
}

export async function openCommandPalette(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("t3code:open-command-palette"));
  });
  await commandPalette(page).waitFor({ state: "visible" });
}

export async function closeCommandPalette(page: Page): Promise<void> {
  if ((await commandPalette(page).count()) === 0) {
    return;
  }
  await page.keyboard.press("Escape");
  await commandPalette(page)
    .waitFor({ state: "hidden" })
    .catch(() => undefined);
}

export async function stopRunningTurnIfNeeded(page: Page): Promise<void> {
  const stop = page.getByRole("button", { name: "Stop generation" });
  if ((await stop.count()) === 0) {
    return;
  }
  await stop.first().scrollIntoViewIfNeeded();
  await stop.first().click();
  await expect
    .poll(
      async () => {
        if ((await stop.count()) === 0) {
          return true;
        }
        return !(await stop.first().isVisible());
      },
      { timeout: 120_000 },
    )
    .toBe(true);
}

export async function submitGoalSlashCommand(page: Page, command: string): Promise<void> {
  await typeInComposer(page, command);
  await submitComposer(page);
}

export async function runPaletteAction(page: Page, query: string): Promise<void> {
  await openCommandPalette(page);
  await paletteInput(page).fill(query);
  await commandPalette(page)
    .locator("[data-slot=command-item]", { hasText: query })
    .first()
    .click();
  await commandPalette(page).waitFor({ state: "hidden" });
}

export async function addProjectFromEmptyState(page: Page, workspaceRoot: string): Promise<void> {
  await addProjectButton(page).click();
  await commandPalette(page).waitFor({ state: "visible" });
  await paletteInput(page).fill(workspaceRoot);
  await page.getByRole("button", { name: /^(Create & )?Add \(/ }).click();
  await commandPalette(page).waitFor({ state: "hidden" });
  await composerEditor(page).waitFor({ state: "visible" });
}

export async function waitForAppReady(page: Page): Promise<"empty" | "composer"> {
  const empty = addProjectButton(page);
  const composer = composerEditor(page);
  const hero = page.getByText("What should we work on?");
  await empty.or(composer).or(hero).waitFor({ state: "visible", timeout: 120_000 });
  if (await composer.isVisible()) {
    return "composer";
  }
  return "empty";
}

export async function waitForEmptyApp(page: Page): Promise<void> {
  await waitForAppReady(page);
}
