import { describe, expect, it } from "vite-plus/test";

import {
  redactText,
  redactUrl,
  resolveVerdict,
  sanitizeConsoleEntries,
  sanitizeNetworkEntries,
  summarizeLogs,
  QA_MAX_LOG_ENTRIES,
} from "./qaEvidence.ts";

describe("redaction", () => {
  it.each([
    ["https://user:hunter2@shop.test/a", "https://shop.test/a"],
    [
      "https://shop.test/cb?access_token=abc&page=2&api_key=k",
      "https://shop.test/cb?access_token=REDACTED&page=2&api_key=REDACTED",
    ],
    ["https://shop.test/#id_token=abc&state=x", "https://shop.test/#id_token=REDACTED&state=x"],
    ["https://shop.test/search?q=shoes", "https://shop.test/search?q=shoes"],
  ])("redacts %s", (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });

  it("masks credentials in log text", () => {
    expect(redactText("fetch failed Authorization: Bearer eyJhbGci.x.y; retry")).toBe(
      "fetch failed Authorization: REDACTED; retry",
    );
    expect(redactText("sent Bearer abc.def")).toBe("sent Bearer REDACTED");
    expect(redactText("cookie=sid=123")).toBe("cookie=REDACTED");
  });

  it("keeps only known log fields, so headers never reach disk", () => {
    const entry = {
      url: "https://shop.test/api?token=t",
      method: "GET",
      status: 401,
      failed: false,
      timestamp: "t",
      headers: { Authorization: "Bearer secret", Cookie: "sid=1" },
    };
    const [saved] = sanitizeNetworkEntries([entry]);
    expect(saved).toEqual({
      url: "https://shop.test/api?token=REDACTED",
      method: "GET",
      status: 401,
      failed: false,
      timestamp: "t",
    });
    expect(JSON.stringify(saved)).not.toContain("secret");
  });

  it("caps how many log entries a scenario keeps", () => {
    const entries = Array.from({ length: QA_MAX_LOG_ENTRIES + 10 }, (_, index) => ({
      level: "log",
      text: `line ${index}`,
      timestamp: "t",
    }));
    const saved = sanitizeConsoleEntries(entries);
    expect(saved).toHaveLength(QA_MAX_LOG_ENTRIES);
    expect(saved.at(-1)?.text).toBe(`line ${QA_MAX_LOG_ENTRIES + 9}`);
  });
});

describe("resolveVerdict", () => {
  it.each([
    ["PASS", true, "PASS"],
    ["FAIL", true, "FAIL"],
    ["PASS", false, "INCONCLUSIVE"],
    ["FAIL", false, "INCONCLUSIVE"],
    ["BLOCKED", false, "BLOCKED"],
    ["SKIPPED", false, "SKIPPED"],
  ] as const)("%s with screenshot=%s is %s", (requested, hasScreenshot, expected) => {
    expect(resolveVerdict(requested, hasScreenshot).verdict).toBe(expected);
  });
});

describe("summarizeLogs", () => {
  it("counts only errors after the previous verdict, since the tab's logs accumulate", () => {
    const consoleEntries = sanitizeConsoleEntries([
      { level: "error", text: "earlier", timestamp: "2026-01-01T00:00:01.000Z" },
      { level: "error", text: "this scenario", timestamp: "2026-01-01T00:00:03.000Z" },
    ]);
    const networkEntries = sanitizeNetworkEntries([
      {
        url: "https://a.test/old",
        method: "GET",
        status: 500,
        failed: false,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        url: "https://a.test/new",
        method: "GET",
        status: 404,
        failed: false,
        timestamp: "2026-01-01T00:00:03.000Z",
      },
    ]);
    const summary = summarizeLogs(consoleEntries, networkEntries, "2026-01-01T00:00:02.000Z");
    expect(summary.consoleErrors).toEqual(["this scenario"]);
    expect(summary.failedRequests.map((request) => request.url)).toEqual(["https://a.test/new"]);
    expect(summarizeLogs(consoleEntries, networkEntries, null).consoleErrorCount).toBe(2);
  });
});
