import { describe, expect, it } from "vite-plus/test";

import { findDeepLinkInArgv, parseDeepLink } from "./DesktopDeepLink.ts";

const SCHEMES = ["t3code", "t3code-dev"] as const;

describe("parseDeepLink", () => {
  it("parses the documented thread link shape", () => {
    expect(parseDeepLink("t3code://threads/env-1/thread-42", SCHEMES)).toEqual({
      kind: "thread",
      environmentId: "env-1",
      threadId: "thread-42",
    });
  });

  it("accepts every registered scheme, including the development one", () => {
    for (const scheme of SCHEMES) {
      expect(parseDeepLink(`${scheme}://threads/env/thread`, SCHEMES)).toEqual({
        kind: "thread",
        environmentId: "env",
        threadId: "thread",
      });
    }
  });

  it("is case insensitive for the scheme and host", () => {
    expect(parseDeepLink("T3CODE://THREADS/env/thread", SCHEMES)).toEqual({
      kind: "thread",
      environmentId: "env",
      threadId: "thread",
    });
  });

  it("percent-decodes segments", () => {
    expect(parseDeepLink("t3code://threads/env%20one/thread%2Btwo", SCHEMES)).toEqual({
      kind: "thread",
      environmentId: "env one",
      threadId: "thread+two",
    });
  });

  it("rejects foreign schemes so other protocol handlers are never hijacked", () => {
    expect(parseDeepLink("https://threads/env/thread", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3codex://threads/env/thread", SCHEMES)).toBeNull();
  });

  it("rejects other hosts, including the renderer bundle URL", () => {
    expect(parseDeepLink("t3code://app/#/env/thread", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3code://oauth/callback", SCHEMES)).toBeNull();
  });

  it("requires exactly two path segments", () => {
    expect(parseDeepLink("t3code://threads/env", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3code://threads/env/thread/extra", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3code://threads", SCHEMES)).toBeNull();
  });

  // A decoded separator would let a crafted link address a different route than
  // the one the two segments appear to describe.
  it("rejects segments that decode back into path separators", () => {
    expect(parseDeepLink("t3code://threads/env%2F..%2Fother/thread", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3code://threads/env/thread%3Fx%3D1", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3code://threads/env/thread%23frag", SCHEMES)).toBeNull();
  });

  it("rejects blank or whitespace-padded segments", () => {
    expect(parseDeepLink("t3code://threads/%20/thread", SCHEMES)).toBeNull();
    expect(parseDeepLink("t3code://threads/env/%20thread", SCHEMES)).toBeNull();
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(parseDeepLink("t3code://threads/%E0%A4%A/thread", SCHEMES)).toBeNull();
  });

  it("rejects input that is not a URL at all", () => {
    expect(parseDeepLink("", SCHEMES)).toBeNull();
    expect(parseDeepLink("not a url", SCHEMES)).toBeNull();
  });
});

describe("findDeepLinkInArgv", () => {
  // Electron passes the full argv of the second launch, so the URL is never the
  // first element in practice.
  it("finds the link among unrelated arguments", () => {
    expect(
      findDeepLinkInArgv(
        ["/path/to/T3 Code", "--allow-file-access", "t3code://threads/env/thread"],
        SCHEMES,
      ),
    ).toBe("t3code://threads/env/thread");
  });

  it("trims surrounding whitespace added by the shell or desktop entry", () => {
    expect(findDeepLinkInArgv(["  t3code://threads/env/thread  "], SCHEMES)).toBe(
      "t3code://threads/env/thread",
    );
  });

  it("returns the first match when several links are present", () => {
    expect(
      findDeepLinkInArgv(["t3code://threads/a/b", "t3code://threads/c/d"], SCHEMES),
    ).toBe("t3code://threads/a/b");
  });

  it("returns null when no argument uses a registered scheme", () => {
    expect(findDeepLinkInArgv(["/path/to/T3 Code", "--flag"], SCHEMES)).toBeNull();
    expect(findDeepLinkInArgv(["https://example.com"], SCHEMES)).toBeNull();
    expect(findDeepLinkInArgv([], SCHEMES)).toBeNull();
  });
});
