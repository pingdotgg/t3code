import { test } from "@e2e-dev/web";

import { pairBrowser } from "../support/pairing.ts";

test.setup("pair this browser", { sessions: ["paired"] }, async ({ app, browser, session }) => {
  await pairBrowser(app, browser);
  await session.save("paired");
});
