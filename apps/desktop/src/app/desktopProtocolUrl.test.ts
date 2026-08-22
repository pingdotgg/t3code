import { assert, describe, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";

import {
  applyPendingDesktopProtocolUrl,
  extractDesktopProtocolUrl,
  loadDesktopProtocolUrl,
  queuePendingDesktopProtocolUrl,
  registerDesktopProtocolWindowLoader,
  takePendingDesktopProtocolUrl,
} from "./desktopProtocolUrl.ts";

describe("extractDesktopProtocolUrl", () => {
  it.each([
    {
      name: "returns a t3code:// URL",
      argv: ["/opt/t3code-bin/t3code", "t3code://app/sso-callback"],
      scheme: "t3code",
      expected: "t3code://app/sso-callback",
    },
    {
      name: "returns a t3code-dev:// URL",
      argv: ["electron", "t3code-dev://app/CLERK-ROUTER/VIRTUAL/sign-in"],
      scheme: "t3code-dev",
      expected: "t3code-dev://app/CLERK-ROUTER/VIRTUAL/sign-in",
    },
    {
      name: "returns null when no protocol URL is present",
      argv: ["/opt/t3code-bin/t3code", "--hidden"],
      scheme: "t3code",
      expected: null,
    },
    {
      name: "ignores flags, empty strings, and file paths",
      argv: [
        "",
        "--inspect",
        "-foo",
        "--t3code://app/from-flag",
        "/Users/alice/Projects/t3code",
        "C:\\Program Files\\T3 Code\\T3 Code.exe",
        "t3code://app/from-url",
      ],
      scheme: "t3code",
      expected: "t3code://app/from-url",
    },
    {
      name: "prefers the last matching URL",
      argv: ["t3code://app/first", "--verbose", "t3code://app/second"],
      scheme: "t3code",
      expected: "t3code://app/second",
    },
    {
      name: "does not match a different desktop scheme",
      argv: ["t3code-dev://app/", "t3code://app/prod"],
      scheme: "t3code-dev",
      expected: "t3code-dev://app/",
    },
  ])("$name", ({ argv, scheme, expected }) => {
    assert.equal(extractDesktopProtocolUrl(argv, scheme), expected);
  });
});

describe("pending desktop protocol URL", () => {
  beforeEach(() => {
    takePendingDesktopProtocolUrl();
  });

  it("keeps the latest queued URL until it is applied", () => {
    const loaded: string[] = [];
    const loadURL = (url: string) => {
      loaded.push(url);
    };

    assert.equal(takePendingDesktopProtocolUrl(), null);
    assert.equal(applyPendingDesktopProtocolUrl({ loadURL }), false);

    queuePendingDesktopProtocolUrl("t3code://app/first");
    queuePendingDesktopProtocolUrl("t3code://app/second");
    assert.equal(applyPendingDesktopProtocolUrl({ loadURL }), true);
    assert.deepEqual(loaded, ["t3code://app/second"]);
    assert.equal(takePendingDesktopProtocolUrl(), null);
    assert.equal(applyPendingDesktopProtocolUrl({ loadURL }), false);
  });

  it("loads through a registered window loader so retries can track the URL", () => {
    const loaded: string[] = [];
    const window = { loadURL: (url: string) => loaded.push(`direct:${url}`) };
    registerDesktopProtocolWindowLoader(window, (url) => {
      loaded.push(`loader:${url}`);
    });

    loadDesktopProtocolUrl(window, "t3code://app/sso-callback");
    assert.deepEqual(loaded, ["loader:t3code://app/sso-callback"]);
  });
});
