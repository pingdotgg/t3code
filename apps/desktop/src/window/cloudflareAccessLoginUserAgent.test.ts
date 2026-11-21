import { expect, it } from "vite-plus/test";

import { embeddedSignInUserAgent } from "./cloudflareAccessLoginUserAgent.ts";

it("keeps only the tokens a plain Chrome sends", () => {
  expect(
    embeddedSignInUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) easydevcode/0.1.16 Chrome/138.0.7204.243 Electron/37.4.0 Safari/537.36",
    ),
  ).toBe(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.243 Safari/537.36",
  );
});
