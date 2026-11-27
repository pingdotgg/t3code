import { expect } from "e2e";

import { testWithPendingCheckout as test } from "./pending-pull-request-checkout.ts";
import { WEB } from "./t3.ts";

test(
  "A successful checkout leaves the moved unsent draft on the destination branch",
  WEB,
  async ({ browser, screen, finishCheckout }) => {
    const composer = screen.getByRole("textbox");
    const prompt = "Explain the pull request changes";
    await composer.fill(prompt);
    const picker = browser.locator("[data-draft-project-trigger]");
    await picker.tap();
    await screen.getByRole("option", "other-project", { exact: true }).tap();
    await picker.filter({ hasText: "other-project" }).waitFor();
    const branch = browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first();
    await branch.filter({ hasText: "main" }).waitFor();

    await finishCheckout();
    await expect(
      screen.getByText("Checkout finished without attaching to the draft"),
    ).toBeVisible();
    await expect(branch).toContainText("main");
    await expect(composer).toHaveText(prompt);
  },
);
