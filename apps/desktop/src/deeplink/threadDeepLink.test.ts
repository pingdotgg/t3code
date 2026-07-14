import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { findThreadDeepLinkInArgv, parseThreadDeepLinkUrl } from "./threadDeepLink.ts";

describe("threadDeepLink", () => {
  it("parses t3://thread/<threadId> URLs", () => {
    assert.deepStrictEqual(
      parseThreadDeepLinkUrl("t3://thread/thread-123"),
      Option.some("thread-123"),
    );
  });

  it("rejects unrelated protocols and hosts", () => {
    assert.isTrue(Option.isNone(parseThreadDeepLinkUrl("t3code://app/")));
    assert.isTrue(Option.isNone(parseThreadDeepLinkUrl("t3://settings/general")));
    assert.isTrue(Option.isNone(parseThreadDeepLinkUrl("https://example.com/thread/abc")));
  });

  it("finds deep links in process argv", () => {
    assert.deepStrictEqual(
      findThreadDeepLinkInArgv([
        "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        "t3://thread/abc",
      ]),
      Option.some("abc"),
    );
  });
});
