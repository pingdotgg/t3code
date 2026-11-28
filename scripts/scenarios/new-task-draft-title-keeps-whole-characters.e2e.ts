import { expect } from "e2e";

import { IOS, test } from "./t3-mobile.ts";

const KEPT = "a".repeat(68);
// The emoji's two UTF-16 units straddle unit 69, where a draft's title is cut.
const PROMPT = `${KEPT}😀 and the rest of the prompt`;

test(
  "An unsent new-task draft's row title ends without a broken character",
  IOS,
  async ({ t3, app, screen, device }) => {
    await t3.project("demo");
    // A local simulator keeps the last run's drafts.
    await app.clearState().catch(() => {});
    await t3.open();

    await screen.getByRole("button", "New chat").tap({ timeout: 120_000 });
    const composer = screen.getByRole("textbox", "Ask anything");
    const projectSearch = screen.getByRole("textbox", "Search projects");
    // The project list slides over the draft, which names its project too.
    await projectSearch.waitFor();
    await composer.waitFor({ state: "hidden" });
    await screen.getByRole("button", "demo").tap();
    await projectSearch.waitFor({ state: "hidden" });
    await composer.fill(PROMPT);
    await screen.getByTestId("BackButton").tap();

    const row = screen.getByLabel(KEPT, { exact: false });
    await row.waitFor({ timeout: 30_000 });
    // The row clips its title before the cut; the discard prompt shows it whole.
    await row.longPress();
    await screen.getByRole("button", "Discard").tap();
    await app.screenshot("discard-prompt");
    await device.alert("dismiss");
    await expect(row).toHaveAccessibleName(`${KEPT}...`);
  },
);
