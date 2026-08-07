import { expect, it } from "@effect/vitest";

import {
  renderLoopbackAuthorizationCompleteHtml,
  resolveLoopbackAuthorizationStage,
} from "./cliAuthHtml.ts";

it("renders the branded loopback authorization completion page", () => {
  const html = renderLoopbackAuthorizationCompleteHtml();

  expect(resolveLoopbackAuthorizationStage()).toBe("dev");
  expect(html).toContain("2code (Dev)");
  expect(html).toContain('class="stage stage-dev"');
  expect(html).not.toContain("Secure terminal handoff");
  expect(html).toContain("You're connected");
  expect(html).toContain("Return to your terminal");
  expect(html).not.toContain('class="next"');
  expect(html).toContain('name="viewport"');
  expect(html).not.toContain('class="status"');
});

it("renders the matching header treatment for each release channel", () => {
  const nightly = renderLoopbackAuthorizationCompleteHtml("nightly");
  const latest = renderLoopbackAuthorizationCompleteHtml("latest");

  expect(nightly).toContain("2code (Nightly)");
  expect(nightly).toContain('class="stage stage-nightly"');
  expect(latest).toContain('<p class="brand">2code</p>');
  expect(latest).not.toContain("(Latest)");
  expect(latest).toContain('class="stage stage-latest"');
});
