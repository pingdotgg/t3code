import { describe, expect, it } from "vite-plus/test";

import { extractPairingLink } from "./DesktopPairingLink.ts";

const link = "t3code://pair?host=https%3A%2F%2Fbackend.example.com&label=Work#token=ABCD1234";

describe("extractPairingLink", () => {
  it("finds the pairing link among launcher argv noise", () => {
    expect(
      extractPairingLink(["/usr/bin/t3code", "--no-sandbox", link, "--foo=bar"], "t3code"),
    ).toBe(link);
  });

  it("returns null when no candidate is a pairing link", () => {
    expect(extractPairingLink(["/usr/bin/t3code", "--no-sandbox"], "t3code")).toBeNull();
    expect(extractPairingLink([], "t3code")).toBeNull();
  });

  it("ignores links on another scheme", () => {
    expect(extractPairingLink([link], "t3code-dev")).toBeNull();
    expect(
      extractPairingLink(["https://backend.example.com/pair#token=ABCD1234"], "t3code"),
    ).toBeNull();
  });

  it("ignores the renderer origin and unknown hosts on the same scheme", () => {
    expect(extractPairingLink(["t3code://app/"], "t3code")).toBeNull();
    expect(extractPairingLink(["t3code://app/settings?host=x#token=y"], "t3code")).toBeNull();
    expect(extractPairingLink(["t3code://other?host=x#token=y"], "t3code")).toBeNull();
  });

  it("matches the scheme case-insensitively and keeps the token fragment", () => {
    const result = extractPairingLink(["T3CODE://pair?host=h#token=t"], "t3code");
    expect(result).not.toBeNull();
    const url = new URL(result!);
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("host")).toBe("h");
    expect(url.hash).toBe("#token=t");
  });

  it("skips malformed candidates without throwing", () => {
    expect(extractPairingLink(["t3code:", "t3code://", link], "t3code")).toBe(link);
  });
});
