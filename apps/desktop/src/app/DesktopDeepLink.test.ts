import { assert, describe, it } from "@effect/vitest";

import { buildDesktopThreadLink, parseDesktopThreadLink } from "./DesktopDeepLink.ts";

describe("DesktopDeepLink", () => {
  it("builds the desktop hash route for an externally supplied thread", () => {
    assert.equal(
      buildDesktopThreadLink({
        isDevelopment: false,
        environmentId: "environment-123",
        threadId: "thread-456",
      }),
      "t3code://app/#/environment-123/thread-456",
    );
  });

  it("parses only a scoped thread route from the desktop scheme", () => {
    assert.deepEqual(
      parseDesktopThreadLink({
        isDevelopment: false,
        value: "t3code://app/#/environment-123/thread-456",
      }),
      {
        environmentId: "environment-123",
        threadId: "thread-456",
      },
    );
    assert.isNull(
      parseDesktopThreadLink({
        isDevelopment: false,
        value: "t3code://app/CLERK-ROUTER/VIRTUAL/sign-in",
      }),
    );
    assert.isNull(
      parseDesktopThreadLink({
        isDevelopment: false,
        value: "t3code://other/#/environment-123/thread-456",
      }),
    );
  });
});
