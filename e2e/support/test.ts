import { test as base } from "@e2e-dev/web";

import { pairBrowser } from "./pairing.ts";
import { type T3, createT3 } from "./t3.ts";

/**
 * `test` for signed-in flows. The `t3` fixture pairs the test's own browser with a fresh
 * token, like a new device, so tests never share local draft state, then hands back the
 * flow helpers.
 */
export const test = base.extend<{ t3: T3 }>({
  t3: async ({ app, browser, screen }, use) => {
    await pairBrowser(app, browser);
    await use(createT3(app, browser, screen));
  },
});

export const describe = test.describe;
