import { describe, expect, it } from "@effect/vitest";

import {
  cursorSessionFromAccessToken,
  decodeJwtPayload,
  parseCsvRows,
  parseCursorUsageCsv,
} from "./usageCursor.ts";

/** Builds an unsigned JWT with the given payload for unit tests. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("cursorSessionFromAccessToken", () => {
  it("builds the Workos cookie from the JWT subject", () => {
    const accessToken = fakeJwt({ sub: "google-oauth2|user_abc" });
    const session = cursorSessionFromAccessToken(accessToken);
    expect(session).toEqual({
      userId: "user_abc",
      sessionToken: `user_abc%3A%3A${accessToken}`,
    });
  });

  it("returns null without a subject", () => {
    expect(cursorSessionFromAccessToken(fakeJwt({}))).toBeNull();
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("parseCursorUsageCsv", () => {
  it("maps token columns into usage records", () => {
    const csv = [
      "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost",
      "2026-06-17T12:00:00.000Z,claude-4-sonnet,100,50,200,30,380,$0.00",
      "2026-06-17 13:00:00,composer-2,0,10,0,5,15,",
    ].join("\n");

    const parsed = parseCursorUsageCsv(csv);
    expect(parsed.ok).toBe(true);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      provider: "cursor",
      model: "claude-4-sonnet",
      totals: {
        uncachedInputTokens: 50,
        cachedInputTokens: 200,
        cacheCreationTokens: 100,
        outputTokens: 30,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
    });
    expect(parsed.records[1]?.model).toBe("composer-2");
    expect(parsed.records[1]?.totals.uncachedInputTokens).toBe(10);
    // Timezone-less export timestamps are UTC, not the server local zone.
    expect(parsed.records[1]?.timestampMs).toBe(Date.parse("2026-06-17T13:00:00Z"));
  });

  it("rejects exports missing required columns", () => {
    const parsed = parseCursorUsageCsv("Date,Model\n2026-01-01,auto");
    expect(parsed.ok).toBe(false);
    expect(parsed.records).toHaveLength(0);
    expect(parsed.message).toContain("missing required column");
  });

  it("treats a header-only CSV as a valid empty export", () => {
    const header =
      "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
    const parsed = parseCursorUsageCsv(header);
    expect(parsed.ok).toBe(true);
    expect(parsed.records).toHaveLength(0);
  });

  it("accepts quoted CSV headers", () => {
    const csv = [
      '"Date","Model","Input (w/ Cache Write)","Input (w/o Cache Write)","Cache Read","Output Tokens"',
      '"2026-06-17T12:00:00.000Z","auto","0","1","0","1"',
    ].join("\n");
    const parsed = parseCursorUsageCsv(csv);
    expect(parsed.ok).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.model).toBe("auto");
  });

  it("rejects a non-CSV body", () => {
    const parsed = parseCursorUsageCsv("<html>not csv</html>");
    expect(parsed.ok).toBe(false);
    expect(parsed.records).toHaveLength(0);
  });

  it("parses quoted CSV fields with commas", () => {
    const rows = parseCsvRows('a,"b,c",d\n1,"2,3",4\n');
    expect(rows).toEqual([
      ["a", "b,c", "d"],
      ["1", "2,3", "4"],
    ]);
  });
});
