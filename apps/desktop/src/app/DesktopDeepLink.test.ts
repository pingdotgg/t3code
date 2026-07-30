import { assert, describe, it } from "@effect/vitest";

import { findDesktopDeepLink, parseDesktopDeepLink } from "./DesktopDeepLink.ts";

describe("DesktopDeepLink", () => {
  it("parses a production thread deep link", () => {
    assert.deepEqual(parseDesktopDeepLink("t3code://threads/environment-1/thread-1", "t3code"), {
      type: "thread",
      environmentId: "environment-1",
      threadId: "thread-1",
    });
  });

  it("decodes environment and thread route components", () => {
    assert.deepEqual(
      parseDesktopDeepLink("t3code://threads/local%20machine/thread%2Fone", "t3code"),
      {
        type: "thread",
        environmentId: "local machine",
        threadId: "thread/one",
      },
    );
  });

  it("keeps production and development schemes separate", () => {
    assert.isNull(parseDesktopDeepLink("t3code://threads/environment-1/thread-1", "t3code-dev"));
    assert.deepEqual(
      parseDesktopDeepLink("t3code-dev://threads/environment-1/thread-1", "t3code-dev"),
      {
        type: "thread",
        environmentId: "environment-1",
        threadId: "thread-1",
      },
    );
  });

  it.each([
    "not-a-url",
    " t3code://threads/environment-1/thread-1",
    "https://threads/environment-1/thread-1",
    "t3code://projects/environment-1/thread-1",
    "t3code://threads/environment-only",
    "t3code://threads/environment-1/thread-1/extra",
    "t3code://threads/environment-1/thread-1?view=review",
    "t3code://threads/environment-1/thread-1#review",
    "t3code://threads//thread-1",
    "t3code://threads/environment-1/",
    "t3code://threads/%20/thread-1",
    "t3code://threads/environment-1/%E0%A4%A",
  ])("rejects unsupported or malformed input: %s", (value) => {
    assert.isNull(parseDesktopDeepLink(value, "t3code"));
  });

  it("finds a deep link among desktop process arguments", () => {
    assert.deepEqual(
      findDesktopDeepLink(
        ["/Applications/T3 Code.app/Contents/MacOS/T3 Code", "--flag", "t3code://threads/env/t1"],
        "t3code",
      ),
      {
        type: "thread",
        environmentId: "env",
        threadId: "t1",
      },
    );
  });
});
