import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { mintPairingToken } from "../support/pairing.ts";

describe("pairing", { tags: ["smoke"] }, () => {
  test("an unpaired browser is sent to pairing", async ({ app, browser, screen }) => {
    await app.open("/");
    await expect(browser).toHaveURL(/\/pair/);
    await expect(screen.getByRole("heading", "Pair with this environment")).toBeVisible();
  });

  test("a pasted pairing token signs the browser in", async ({ app, browser, screen }) => {
    await app.open("/pair");
    await screen.getByLabel("Pairing token").fill(await mintPairingToken(app.baseUrl));
    await screen.getByRole("button", "Continue").tap();
    await expect(browser).not.toHaveURL(/\/pair/);
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  });
});
