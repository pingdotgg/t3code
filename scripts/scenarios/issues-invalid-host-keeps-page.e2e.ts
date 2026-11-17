import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("An invalid host filter keeps the Issues page open", WEB, async ({ t3, app, browser }) => {
  await t3.project("demo");
  await t3.open("/issues?host=true");

  await app.screenshot("issues-invalid-host");
  await expect(browser.locator("h1")).toHaveText("Issues");
});
