import { expect } from "e2e";

import { IOS, test } from "./t3-mobile.ts";

test("iOS can cite a word inside an assistant table cell", IOS, async ({ t3, app, screen }) => {
  const project = await t3.project("Table fixture");
  await t3.thread({
    project,
    title: "Table selection",
    messages: ["Show me a table"],
    model: "showcase",
  });
  await t3.open();

  const thread = screen.getByText("Table selection", { exact: false }).first();
  await expect(thread).toBeVisible({ timeout: 120_000 });
  await thread.tap();

  const result = screen.getByText("12 passed", { exact: false }).first();
  await expect(result).toBeVisible();
  await result.longPress();
  await app.screenshot("table-selection");
  await screen.getByText("Cite", { exact: true }).first().tap();
  await expect(screen.getByRole("button", "passed")).toBeVisible();
  await app.screenshot("table-quote");
});
