import { assert, describe, it } from "@effect/vitest";

import {
  buildProviderFailureReportUrl,
  MAX_REPORT_URL_CHARS,
  REPORT_ACTUAL_INSTRUCTION,
  reportTitleFromFailure,
} from "./ProviderFailureReportLink.ts";

const base = {
  failureMessage:
    "The provider could not start this turn: Failed to read attachment '/Users/alex/secret/notes.txt' for buildhost token correcthorse.",
  driver: "codex",
  runtimeMode: "full-access",
  platform: "darwin arm64",
  serverVersion: "0.0.46",
} as const;

const parse = (url: string) => new URL(url);

describe("buildProviderFailureReportUrl", () => {
  it("opens the bug form with only safe, structured fields", () => {
    const url = buildProviderFailureReportUrl(base)!;
    const parsed = parse(url);
    const params = parsed.searchParams;

    assert.equal(parsed.origin + parsed.pathname, "https://github.com/pingdotgg/t3code/issues/new");
    assert.equal(params.get("template"), "bug_report.yml");
    assert.equal(
      params.get("title"),
      "[Bug]: Provider failure: start turn failed read attachment token",
    );
    assert.equal(params.get("actual"), REPORT_ACTUAL_INSTRUCTION);
    assert.equal(
      params.get("environment"),
      "Provider: codex, Runtime mode: full-access, OS: darwin arm64",
    );
    assert.equal(params.get("version"), "0.0.46");
    assert.sameMembers(
      [...params.keys()],
      ["template", "title", "actual", "environment", "version"],
    );
  });

  it("carries none of the error text, and no model text", () => {
    const decoded = decodeURIComponent(buildProviderFailureReportUrl(base)!);
    for (const leaked of [
      "/Users",
      "alex",
      "secret",
      "notes.txt",
      "buildhost",
      "correcthorse",
      "could not",
      "Failed to read",
    ]) {
      assert.notInclude(decoded, leaked);
    }
  });

  it("falls back to a generic title when too few vocabulary words match", () => {
    assert.equal(
      reportTitleFromFailure("Invalid API_KEY: correcthorse"),
      "[Bug]: Provider failure",
    );
    const { searchParams } = parse(
      buildProviderFailureReportUrl({ ...base, failureMessage: "Invalid API_KEY: correcthorse" })!,
    );
    assert.equal(searchParams.get("title"), "[Bug]: Provider failure");
  });

  it("omits the version when the server does not know it", () => {
    assert.isFalse(
      parse(buildProviderFailureReportUrl({ ...base, serverVersion: null })!).searchParams.has(
        "version",
      ),
    );
  });

  it("names only a known driver", () => {
    const environment = (driver: string | null) =>
      parse(buildProviderFailureReportUrl({ ...base, driver })!).searchParams.get("environment");
    assert.include(environment("claudeAgent"), "Provider: claude,");
    assert.include(environment("my-private-driver"), "Provider: unknown,");
    assert.include(environment(null), "Provider: unknown,");
  });

  it("percent-encodes values, so the form reads them back exactly", () => {
    const url = buildProviderFailureReportUrl({ ...base, serverVersion: "a&b #1 é" })!;
    assert.notInclude(url, " ");
    assert.include(url, "%26");
    assert.equal(parse(url).searchParams.get("version"), "a&b #1 é");
    assert.equal(
      parse(url).searchParams.get("environment"),
      "Provider: codex, Runtime mode: full-access, OS: darwin arm64",
    );
  });

  // encodeURIComponent throws on a lone surrogate; construction must never throw.
  it("builds a link even when a value holds a lone surrogate or an emoji", () => {
    for (const serverVersion of ["\ud83d", "1.0-😀", "\ude00x"]) {
      const url = buildProviderFailureReportUrl({ ...base, serverVersion });
      assert.isString(url);
      assert.isTrue(decodeURIComponent(url!).isWellFormed());
    }
  });

  it("builds a link for failure text with emoji at any cut point", () => {
    for (const failureMessage of [
      `${"word ".repeat(15)}x😀 tail`,
      `Failed ${"😀".repeat(1_000)}`,
      `Failed ${"😀".repeat(5_001)} attachment`,
    ]) {
      const url = buildProviderFailureReportUrl({ ...base, failureMessage });
      assert.isString(url);
      assert.isTrue(decodeURIComponent(url!).isWellFormed());
    }
  });

  it("returns null, never throws, when no link of a usable length exists", () => {
    const url = buildProviderFailureReportUrl({
      ...base,
      serverVersion: "v".repeat(MAX_REPORT_URL_CHARS),
    });
    assert.isNull(url);
  });
});

describe("reportTitleFromFailure", () => {
  it("uses only vocabulary words, in order, at most six", () => {
    assert.equal(
      reportTitleFromFailure(
        "Connection reset by buildhost: stream closed, timeout, session crashed, permission denied, sandbox killed",
      ),
      "[Bug]: Provider failure: connection reset stream closed timeout session",
    );
  });
});
