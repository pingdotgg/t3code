import * as NodeTimersPromises from "node:timers/promises";

// Opens a fresh draft on the new-thread screen, picking the first project when asked.
export async function openNewThread(page, origin) {
  await page.goto(origin);
  await page
    .getByRole("button", { name: "New thread", exact: true })
    .first()
    .waitFor({ timeout: 90_000 });
  await NodeTimersPromises.setTimeout(1500);
  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  // New thread asks for a project; take the first one.
  const picker = page.locator('[data-slot="command-dialog-backdrop"]');
  await picker.waitFor({ timeout: 5000 }).catch(() => {});
  if (await picker.count()) {
    await NodeTimersPromises.setTimeout(800);
    await page.keyboard.press("Enter");
    await picker.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
  await page
    .locator('[data-composer-shortcut="composer.effort"], [data-chat-provider-model-picker="true"]')
    .first()
    .waitFor({ timeout: 30_000 });
  await NodeTimersPromises.setTimeout(2500);
}
