import { describe, expect, it } from "vite-plus/test";

import {
  T3ConnectionCodeInvalidError,
  decodeFederationPeerCode,
  decodeTailcatConnectionCode,
  encodeFederationPeerCode,
  encodeTailcatConnectionCode,
  isT3ConnectionCode,
  peekT3ConnectionCodeKind,
  redactT3ConnectionCode,
} from "./t3ConnectionCode.ts";

const ADDRESS =
  "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu";

describe("t3ConnectionCode", () => {
  it("round-trips a tailcat connection code", () => {
    const code = encodeTailcatConnectionCode({
      v: 1,
      transport: "tailcat",
      address: ADDRESS,
      port: 3773,
      name: "gpu-box",
      pairingToken: "one-time-secret",
      expiresAt: "2026-09-03T12:00:00.000Z",
    });
    expect(code.startsWith("t3c://tailcat/")).toBe(true);
    expect(code).not.toContain("one-time-secret");
    expect(decodeTailcatConnectionCode(code)).toEqual({
      v: 1,
      transport: "tailcat",
      address: ADDRESS,
      port: 3773,
      name: "gpu-box",
      pairingToken: "one-time-secret",
      expiresAt: "2026-09-03T12:00:00.000Z",
    });
  });

  it("tolerates surrounding whitespace and case in the scheme", () => {
    const code = encodeTailcatConnectionCode({
      v: 1,
      transport: "tailcat",
      address: ADDRESS,
      port: 3773,
    });
    expect(decodeTailcatConnectionCode(`  ${code.replace("t3c://", "T3C://")}\n`).port).toBe(3773);
  });

  it("rejects text that is not a code with an actionable reason", () => {
    expect(() => decodeTailcatConnectionCode("https://example.com/pair#token=x")).toThrowError(
      T3ConnectionCodeInvalidError,
    );
    try {
      decodeTailcatConnectionCode("hello");
    } catch (error) {
      expect(error).toBeInstanceOf(T3ConnectionCodeInvalidError);
      expect((error as T3ConnectionCodeInvalidError).reason).toBe("not-a-code");
    }
  });

  it("rejects damaged payloads", () => {
    try {
      decodeTailcatConnectionCode("t3c://tailcat/not-base64!!");
    } catch (error) {
      expect((error as T3ConnectionCodeInvalidError).reason).toBe("malformed-payload");
    }
    const validPrefix = encodeTailcatConnectionCode({
      v: 1,
      transport: "tailcat",
      address: ADDRESS,
      port: 3773,
    });
    try {
      decodeTailcatConnectionCode(validPrefix.slice(0, validPrefix.length - 12));
    } catch (error) {
      expect((error as T3ConnectionCodeInvalidError).reason).toBe("malformed-payload");
    }
  });

  it("reports unsupported future versions distinctly", () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 2, transport: "tailcat", address: ADDRESS, port: 3773 }),
    ).toString("base64url");
    try {
      decodeTailcatConnectionCode(`t3c://tailcat/${payload}`);
    } catch (error) {
      expect((error as T3ConnectionCodeInvalidError).reason).toBe("unsupported-version");
    }
  });

  it("rejects the wrong kind of code", () => {
    const peer = encodeFederationPeerCode({
      v: 1,
      kind: "peer",
      protocolVersion: 1,
      environmentId: "env-b" as never,
      publicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      label: "gpu-box",
      transport: { tailcat: { address: ADDRESS, port: 3773 } },
      token: "one-time",
      scopes: ["environment.read", "projects.read"],
      expiresAt: "2026-09-03T12:00:00.000Z",
    });
    expect(peekT3ConnectionCodeKind(peer)).toBe("peer");
    expect(decodeFederationPeerCode(peer).scopes).toEqual(["environment.read", "projects.read"]);
    try {
      decodeTailcatConnectionCode(peer);
    } catch (error) {
      expect((error as T3ConnectionCodeInvalidError).reason).toBe("kind-mismatch");
    }
  });

  it("recognizes codes and redacts them for logs", () => {
    const code = encodeTailcatConnectionCode({
      v: 1,
      transport: "tailcat",
      address: ADDRESS,
      port: 3773,
      pairingToken: "one-time-secret",
    });
    expect(isT3ConnectionCode(code)).toBe(true);
    expect(isT3ConnectionCode("tc123")).toBe(false);
    const redacted = redactT3ConnectionCode(code);
    expect(redacted.startsWith("t3c://tailcat/…")).toBe(true);
    expect(redacted.length).toBeLessThan(40);
    expect(peekT3ConnectionCodeKind("nope")).toBeNull();
  });
});
