import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await t3.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
