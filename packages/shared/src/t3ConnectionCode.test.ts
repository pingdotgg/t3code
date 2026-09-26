import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  T3ConnectionCodeInvalidError,
  decodeTailcatConnectionCode,
  describeTailcatConnectionCode,
  encodeTailcatConnectionCode,
  isT3ConnectionCode,
  peekT3ConnectionCodeKind,
  redactT3ConnectionCode,
} from "./t3ConnectionCode.ts";

const ADDRESS =
  "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu";

const TAILCAT_PAYLOAD = {
  v: 1,
  transport: "tailcat",
  address: ADDRESS,
  port: 3773,
  environmentId: EnvironmentId.make("env-gpu"),
  name: "gpu-box",
  serverVersion: "0.9.0",
  pairingToken: "one-time-secret",
  expiresAt: "2026-09-03T12:00:00.000Z",
} as const;

describe("t3ConnectionCode", () => {
  it("round-trips a tailcat connection code", () => {
    const code = encodeTailcatConnectionCode(TAILCAT_PAYLOAD);
    expect(code.startsWith("t3c://tailcat/")).toBe(true);
    expect(code).not.toContain("one-time-secret");
    expect(decodeTailcatConnectionCode(code)).toEqual(TAILCAT_PAYLOAD);
  });

  it("tolerates surrounding whitespace and case in the scheme", () => {
    const code = encodeTailcatConnectionCode(TAILCAT_PAYLOAD);
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
    const validPrefix = encodeTailcatConnectionCode(TAILCAT_PAYLOAD);
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

  it("rejects codes of a kind this app does not support", () => {
    const code = `t3c://other/${Buffer.from(JSON.stringify({ v: 1 })).toString("base64url")}`;
    expect(peekT3ConnectionCodeKind(code)).toBeNull();
    try {
      decodeTailcatConnectionCode(code);
    } catch (error) {
      expect((error as T3ConnectionCodeInvalidError).reason).toBe("unknown-kind");
    }
  });

  it("recognizes codes and redacts them for logs", () => {
    const code = encodeTailcatConnectionCode(TAILCAT_PAYLOAD);
    expect(isT3ConnectionCode(code)).toBe(true);
    expect(isT3ConnectionCode("tc123")).toBe(false);
    const redacted = redactT3ConnectionCode(code);
    expect(redacted.startsWith("t3c://tailcat/…")).toBe(true);
    expect(redacted.length).toBeLessThan(40);
    expect(peekT3ConnectionCodeKind("nope")).toBeNull();
  });

  it("previews a pasted code for the connect form", () => {
    const code = encodeTailcatConnectionCode(TAILCAT_PAYLOAD);
    expect(describeTailcatConnectionCode(`  ${code}\n`)).toEqual({
      kind: "valid",
      payload: expect.objectContaining({ address: ADDRESS, port: 3773, name: "gpu-box" }),
      expiresAtMs: Date.parse(TAILCAT_PAYLOAD.expiresAt),
    });
    expect(describeTailcatConnectionCode("")).toEqual({ kind: "empty" });
    expect(describeTailcatConnectionCode("https://example.com/pair#token=x")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("t3c://tailcat/"),
    });
    expect(describeTailcatConnectionCode("t3c://tailcat/%%%")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("incomplete or damaged"),
    });
  });
});
