import { assert, describe, it } from "@effect/vitest";

import { isSameOriginRendererNavigation } from "./RendererNavigation.ts";

describe("isSameOriginRendererNavigation", () => {
  it("compares protocol and host instead of origin", () => {
    for (const applicationUrl of ["t3code://app/", "t3code-dev://app/"]) {
      assert.isTrue(
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: `${applicationUrl}threads?id=1#latest`,
        }),
        applicationUrl,
      );
    }
    for (const navigationUrl of [
      "t3code://other/",
      "t3code://app.example/",
      "t3code://app:8080/",
      "t3code://user@other/",
      "t3code:app",
      "t3code-dev://app/",
      "file:///etc/passwd",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "about:blank",
      "blob:t3code://app/0b5e2c4a",
      "not a url",
    ]) {
      assert.isFalse(
        isSameOriginRendererNavigation({
          applicationUrl: "t3code://app/",
          navigationUrl,
        }),
        navigationUrl,
      );
    }
    assert.isFalse(
      isSameOriginRendererNavigation({
        applicationUrl: "data:text/html,app",
        navigationUrl: "data:text/html,other",
      }),
    );
  });
});
