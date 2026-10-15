import { describe, expect, it } from "vite-plus/test";

import { clockSkewFromDateHeader, describeClockSkew } from "./clockSkew.ts";

const relayNow = Date.parse("Wed, 14 Oct 2026 09:00:00 GMT");

describe("clockSkewFromDateHeader", () => {
  it("reports a clock that is minutes behind the relay", () => {
    expect(clockSkewFromDateHeader("Wed, 14 Oct 2026 09:00:00 GMT", relayNow - 7 * 60_000)).toBe(
      -420,
    );
  });

  it("reports a clock that is hours ahead of the relay", () => {
    expect(
      clockSkewFromDateHeader("Wed, 14 Oct 2026 09:00:00 GMT", relayNow + 3 * 60 * 60_000),
    ).toBe(10_800);
  });

  it("ignores a gap the relay still accepts", () => {
    expect(clockSkewFromDateHeader("Wed, 14 Oct 2026 09:00:00 GMT", relayNow + 59_000)).toBeNull();
    expect(clockSkewFromDateHeader("Wed, 14 Oct 2026 09:00:00 GMT", relayNow - 59_000)).toBeNull();
  });

  it("cannot judge a response without a usable date", () => {
    expect(clockSkewFromDateHeader(undefined, relayNow + 3_600_000)).toBeNull();
    expect(clockSkewFromDateHeader("not a date", relayNow + 3_600_000)).toBeNull();
  });
});

describe("describeClockSkew", () => {
  it("says how far off the clock is and how to fix it on Windows", () => {
    const message = describeClockSkew(-420, "win32");
    expect(message).toContain("This computer's clock is 7 minutes behind");
    expect(message).toContain('"Sync now"');
    expect(message).toContain("reconnects by itself");
  });

  it("uses the host's own settings path on macOS and Linux", () => {
    expect(describeClockSkew(3_600, "darwin")).toContain("1 hour ahead");
    expect(describeClockSkew(3_600, "darwin")).toContain("System Settings");
    expect(describeClockSkew(2 * 86_400, "linux")).toContain("2 days ahead");
    expect(describeClockSkew(2 * 86_400, "linux")).toContain("timedatectl set-ntp true");
  });
});
