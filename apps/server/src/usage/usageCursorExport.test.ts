import { describe, expect, it } from "vite-plus/test";

import {
  cursorExportCachePath,
  parseCursorUsageCsv,
  sessionTokenFromAccessToken,
  userIdFromAccessTokenJwt,
} from "./usageCursorExport.ts";

function makeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("userIdFromAccessTokenJwt", () => {
  it("extracts user_ id from auth0 sub", () => {
    expect(userIdFromAccessTokenJwt(makeJwt("auth0|user_abc123"))).toBe("user_abc123");
  });

  it("returns null for malformed tokens", () => {
    expect(userIdFromAccessTokenJwt("not-a-jwt")).toBeNull();
    expect(userIdFromAccessTokenJwt(makeJwt("auth0|account"))).toBeNull();
  });
});

describe("sessionTokenFromAccessToken", () => {
  it("builds the WorkosCursorSessionToken cookie value", () => {
    const accessToken = makeJwt("auth0|user_xyz");
    expect(sessionTokenFromAccessToken(accessToken)).toEqual({
      userId: "user_xyz",
      sessionToken: `user_xyz%3A%3A${accessToken}`,
    });
  });
});

describe("cursorExportCachePath", () => {
  it("scopes the CSV cache file to the Cursor user id", () => {
    expect(cursorExportCachePath("/tmp/state", "user_abc")).toBe(
      "/tmp/state/usage-cursor-export.user_abc.csv",
    );
    expect(cursorExportCachePath("/tmp/state", "user/../evil")).toBe(
      "/tmp/state/usage-cursor-export.user____evil.csv",
    );
  });
});

describe("parseCursorUsageCsv", () => {
  it("parses the legacy v1 format", () => {
    const csv = `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you
2025-02-01,gpt-4o,10,5,0,15,30,$0.10,$0.10
2025-02-02,gpt-4o-mini,0,0,0,5,5,$0.05,$0.05`;

    const records = parseCursorUsageCsv(csv, "user_1");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "cursor",
      model: "gpt-4o",
      totals: {
        uncachedInputTokens: 5,
        cachedInputTokens: 0,
        cacheCreationTokens: 10,
        outputTokens: 15,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.1,
    });
    expect(records[1]?.model).toBe("gpt-4o-mini");
  });

  it("parses the v2 Kind format", () => {
    const csv = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2025-11-13T18:36:05.846Z","Included","auto","No","28342","775","105891","21282","156290","0.19"
"2025-11-13T13:35:04.658Z","On-Demand","gpt-5-codex","No","0","8263","66964","1612","76839","0.03"`;

    const records = parseCursorUsageCsv(csv, "user_1");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      model: "auto",
      totals: {
        uncachedInputTokens: 775,
        cachedInputTokens: 105891,
        cacheCreationTokens: 28342,
        outputTokens: 21282,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.19,
    });
    expect(records[1]?.model).toBe("gpt-5-codex");
  });

  it("parses the v3 format and leaves Included/- costs unreported for LiteLLM", () => {
    const csv = `Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-04-09T20:01:10.528Z","bc-a","cc-a","Included","composer-2","Yes","0","343446","29045760","915201","30304407","Included"
"2026-04-09T18:02:13.576Z","bc-b","cc-b","On-Demand","composer-2","Yes","0","43478","420864","7957","472299","0.11"
"2026-04-09T07:39:09.091Z","bc-c","","Errored, No Charge","composer-2","Yes","0","104504","985600","3666","1093770","-"`;

    const records = parseCursorUsageCsv(csv, "user_1");
    expect(records).toHaveLength(3);
    expect(records[0]?.reportedCostUsd).toBeNull();
    expect(records[0]?.totals.cacheCreationTokens).toBe(0);
    expect(records[0]?.totals.uncachedInputTokens).toBe(343446);
    expect(records[1]?.reportedCostUsd).toBe(0.11);
    expect(records[2]?.reportedCostUsd).toBeNull();
  });

  it("returns empty for non-CSV payloads", () => {
    expect(parseCursorUsageCsv('{"error":true}', "user_1")).toEqual([]);
  });

  it("collapses ISO-timestamp rows to one session per calendar day", () => {
    const csv = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2025-11-13T18:36:05.846Z","On-Demand","gpt-5-codex","No","0","8263","66964","1612","76839","0.03"
"2025-11-13T13:35:04.658Z","On-Demand","gpt-5-codex","No","0","2000","1000","500","3500","0.02"`;

    const records = parseCursorUsageCsv(csv, "user_1");
    expect(records).toHaveLength(2);
    expect(records[0]?.sessionId).toBe("cursor-user_1-2025-11-13");
    expect(records[1]?.sessionId).toBe("cursor-user_1-2025-11-13");
  });
});
