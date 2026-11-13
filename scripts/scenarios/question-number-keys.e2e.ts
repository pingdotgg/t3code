import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Number keys tick a question's options, and Enter after a click answers it",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    await t3.thread({
      project,
      title: "Release steps",
      messages: ["Which release steps may you take?"],
      model: "multi-choice",
    });
    await t3.open();
    await screen.getByRole("button", "Release steps", { exact: false }).first().tap();
    const option = (label: string) => screen.getByRole("button", label, { exact: false });
    await expect(option("Push to PR #12")).toBeVisible();
    // Reading the question leaves nothing focused, the state a number key arrives in.
    await screen.getByText("Which outward steps may I take now?", { exact: false }).tap();

    await browser.keyboard.press("1");
    await app.screenshot("number-key");
    await expect(option("Push to PR #12")).toHaveAttribute("aria-pressed", "true");

    await option("Merge #12 when green").tap();
    await browser.keyboard.press("Enter");
    await expect(screen.getByText("Multiple choice fixture complete.")).toBeVisible();
    await app.screenshot("enter-after-click");
  },
);
