import { expect, it } from "@effect/vitest";

import { renderLoopbackAuthorizationCompleteHtml } from "./cliAuthHtml.ts";

it("renders the branded loopback authorization completion page", () => {
  const html = renderLoopbackAuthorizationCompleteHtml();

  expect(html).toContain("T3 Code");
  expect(html).not.toContain("Secure terminal handoff");
  expect(html).toContain("You're connected");
  expect(html).toContain("return to the terminal");
  expect(html).toContain('name="viewport"');
});
