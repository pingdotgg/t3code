import { expect } from "e2e";

import { testWithPendingCheckout as test } from "./pending-pull-request-checkout.ts";
import { WEB } from "./t3.ts";

test(
  "A draft moved during checkout can be reviewed and sent again",
  WEB,
  async ({ browser, screen, finishCheckout }) => {
    const composer = screen.getByRole("textbox");
    const prompt = "Explain the pull request changes";
    await composer.fill(prompt);
    await composer.press("Enter");
    const picker = browser.locator("[data-draft-project-trigger]");
    await picker.tap();
    await screen.getByRole("option", "other-project", { exact: true }).tap();
    await picker.filter({ hasText: "other-project" }).waitFor();
    await expect(
      screen.getByText("Draft changed while preparing this message. Review it and send again."),
    ).toBeVisible();
    await expect(composer).toHaveText(prompt);

    await composer.press("Enter");
    await expect(screen.getByText(prompt, { exact: true })).toBeVisible();
    await expect(composer).toHaveText("");
    await finishCheckout();
    await expect(
      screen.getByText("Checkout finished without attaching to the draft"),
    ).toBeVisible();
  },
);
