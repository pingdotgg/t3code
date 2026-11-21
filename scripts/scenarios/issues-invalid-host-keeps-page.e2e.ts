import { expect } from "e2e";

import { test, WEB } from "./lathe.ts";

test("An invalid host filter keeps the Issues page open", WEB, async ({ lathe, app, browser }) => {
  await lathe.project("demo");
  await lathe.open("/issues?host=true");

  await app.screenshot("issues-invalid-host");
  await expect(browser.locator("h1")).toHaveText("Issues");
});
