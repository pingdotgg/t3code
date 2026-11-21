import { expect } from "e2e";

import { test, WEB } from "./lathe.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ lathe, app, screen }) => {
    const project = await lathe.project("demo");
    const thread = await lathe.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await lathe.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
