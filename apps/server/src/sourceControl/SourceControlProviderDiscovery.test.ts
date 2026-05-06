import { describe, expect, it } from "vitest";
import { Option } from "effect";

import {
  combinedAuthOutput,
  firstNonEmptyLine,
  firstSafeAuthLine,
  matchFirst,
  parseCliHost,
  providerAuth,
} from "./SourceControlProviderDiscovery.ts";

describe("SourceControlProviderDiscovery", () => {
  it("parses safe CLI discovery details", () => {
    expect(Option.getOrNull(firstNonEmptyLine("\n  gh version 2.0\n"))).toBe("gh version 2.0");
    expect(firstSafeAuthLine("Token scopes: repo\nLogged in to github.com as steven")).toBe(
      "Logged in to github.com as steven",
    );
    expect(parseCliHost("github.com\nLogged in")).toBe("github.com");
    expect(matchFirst("Logged in to github.com as steven", [/as\s+([^\s]+)/u])).toBe("steven");
  });

  it("builds redacted auth objects", () => {
    expect(
      providerAuth({ status: "authenticated", account: " steven ", host: " github.com " }),
    ).toMatchObject({
      status: "authenticated",
      account: Option.some("steven"),
      host: Option.some("github.com"),
    });
    expect(combinedAuthOutput({ stdout: "ok", stderr: "warn", exitCode: 0 })).toBe("ok\nwarn");
  });
});
