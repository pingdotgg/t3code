import { expect } from "e2e";

import { IOS, test } from "./t3-mobile.ts";

const LINES = Array.from({ length: 60 }, (_, index) => `Line ${index + 1}: filler for the feed.`);

test(
  "Tapping the Working pill while scrolled up scrolls the thread to the end",
  IOS,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    await t3.workingThread({ project, title: "Long turn", message: LINES.join("\n") });
    await t3.open();

    const workingGroup = screen.getByRole("button", "1 working thread");
    await expect(workingGroup).toBeVisible({ timeout: 120_000 });
    await workingGroup.tap();
    await screen.getByText("Long turn", { exact: false }).first().tap();
    // A tap during the thread's opening transition is dropped, so expand once the feed has loaded.
    await expect(screen.getByText("Thinking", { exact: false }).first()).toBeVisible();
    await screen.getByRole("button", `Agent: ${LINES[0]}`).tap();
    await expect(screen.getByText("Line 60:", { exact: false }).first()).toBeVisible();

    // At the end both versions show the plain label, so its centre is where the pill sits.
    const label = (await screen.getByText("Working", { exact: false }).first().boundingBox())!;
    const pill = { x: label.x + label.width / 2, y: label.y + label.height / 2 };

    await screen.swipe({ direction: "up" });
    await expect(screen.getByRole("button", "Scroll to end").first()).toBeEnabled();
    await app.screenshot("scrolled-up");

    await screen.tapAt(pill);
    await app.screenshot("after-tapping-working");
    await expect(screen.getByRole("button", "Scroll to end")).toBeDisabled();
  },
);
