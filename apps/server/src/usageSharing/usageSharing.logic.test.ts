import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { RelayUsageMeter } from "./relayUsage.ts";
import {
  decodeShareCode,
  encodeShareCode,
  grantSecretMatches,
  grantToken,
  hashGrantSecret,
  newGrantId,
  newGrantSecret,
  parseGrantToken,
} from "./shareCode.ts";
import { admitRequest, currentUsage, periodStart, usedFraction } from "./shareLimits.ts";

describe("share codes", () => {
  it("round-trips a code and rejects tampered or foreign input", () => {
    const payload = {
      endpoint: "http://100.64.0.2:3773",
      grantId: newGrantId(),
      secret: newGrantSecret(),
    };
    const code = encodeShareCode(payload);
    expect(decodeShareCode(`  ${code}\n`)).toEqual(payload);
    expect(decodeShareCode(code.slice(0, -4))).toBeNull();
    expect(decodeShareCode("hello")).toBeNull();
    expect(
      decodeShareCode(encodeShareCode({ ...payload, endpoint: "file:///etc/passwd" })),
    ).toBeNull();
    expect(decodeShareCode(encodeShareCode({ ...payload, secret: "short" }))).toBeNull();
  });

  it("stores only a hash and compares secrets in constant time", () => {
    const secret = newGrantSecret();
    const hash = hashGrantSecret(secret);
    expect(hash).not.toContain(secret);
    expect(grantSecretMatches(secret, hash)).toBe(true);
    expect(grantSecretMatches(`${secret}x`, hash)).toBe(false);
    expect(grantSecretMatches(secret, "00")).toBe(false);
  });

  it("parses bearer tokens", () => {
    const token = grantToken({ grantId: "abcDEF123", secret: "s3cret.with.dots" });
    expect(parseGrantToken(`Bearer ${token}`)).toEqual({
      grantId: "abcDEF123",
      secret: "s3cret.with.dots",
    });
    expect(parseGrantToken("Bearer nodot")).toBeNull();
    expect(parseGrantToken(null)).toBeNull();
  });
});

describe("share limits", () => {
  const limits = { maxRequests: 3, maxTokens: 1000, period: "day" as const, maxConcurrent: 2 };
  const fresh = {
    periodStart: periodStart("day", DateTime.makeUnsafe("2026-11-15T10:00:00Z")),
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  it("starts periods at UTC midnight, Monday, and the 1st", () => {
    const now = DateTime.makeUnsafe("2026-11-15T10:00:00Z"); // a Sunday
    expect(periodStart("day", now)).toBe("2026-11-15T00:00:00.000Z");
    expect(periodStart("week", now)).toBe("2026-11-09T00:00:00.000Z");
    expect(periodStart("month", now)).toBe("2026-11-01T00:00:00.000Z");
    expect(
      currentUsage({ ...fresh, requests: 3 }, "day", DateTime.makeUnsafe("2026-11-16T00:00:01Z"))
        .requests,
    ).toBe(0);
  });

  it("counts requests in flight so parallel requests cannot exceed the budget", () => {
    expect(admitRequest({ limits, usage: { ...fresh, requests: 1 }, inFlight: 1 }).ok).toBe(true);
    expect(admitRequest({ limits, usage: { ...fresh, requests: 2 }, inFlight: 1 })).toMatchObject({
      ok: false,
      reason: "requests",
    });
    expect(admitRequest({ limits, usage: fresh, inFlight: 2 })).toMatchObject({
      ok: false,
      reason: "concurrency",
    });
    expect(
      admitRequest({
        limits,
        usage: { ...fresh, inputTokens: 600, outputTokens: 400 },
        inFlight: 0,
      }),
    ).toMatchObject({ ok: false, reason: "tokens" });
    expect(usedFraction(limits, { ...fresh, requests: 1, inputTokens: 900 })).toBe(0.9);
  });
});

describe("RelayUsageMeter", () => {
  it("reads Anthropic streaming usage across chunk boundaries without double counting", () => {
    const meter = new RelayUsageMeter(true);
    meter.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":1}}}\n\n',
    );
    meter.push('data: {"type":"message_delta","usage":{"output_t');
    meter.push('okens":40}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n');
    expect(meter.finish()).toEqual({
      usage: { inputTokens: 150, outputTokens: 55 },
      measured: true,
    });
  });

  it("reads Responses API and plain JSON usage", () => {
    const stream = new RelayUsageMeter(true);
    stream.push(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\ndata: [DONE]\n',
    );
    expect(stream.finish().usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const json = new RelayUsageMeter(false);
    json.push('{"usage":{"prompt_tokens":7,');
    json.push('"completion_tokens":3}}');
    expect(json.finish()).toEqual({ usage: { inputTokens: 7, outputTokens: 3 }, measured: true });
    expect(new RelayUsageMeter(false).finish().measured).toBe(false);
  });
});
