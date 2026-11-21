import { expect } from "e2e";

import { test, WEB } from "./lathe.ts";

test(
  "A replayed turn streams a reply, shows its tool calls, and finishes",
  WEB,
  async ({ lathe, app, screen }) => {
    await lathe.project("demo", { "src/math.ts": "export const sum = 1 + 1;\n" });
    await lathe.open();

    await screen.getByRole("textbox").fill("Give me a short tour");
    await screen.getByRole("textbox").press("Enter");
    const stop = screen.getByRole("button", "Stop generation");
    await expect(
      screen.getByText("The project has a single math module", { exact: false }),
    ).toBeVisible();
    await expect(stop).toBeVisible();
    await app.screenshot("streaming");

    await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();
    await expect(stop).toBeHidden();
    await expect(screen.getByText("Give me a short tour").first()).toBeVisible();
    await app.screenshot("finished");
  },
);
