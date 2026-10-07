import { assert, describe, it } from "@effect/vitest";

import {
  buildProviderFailureReportUrl,
  MAX_REPORT_URL_CHARS,
  titleFromFailure,
} from "./ProviderFailureReportLink.ts";

const base = {
  failureMessage: "The provider could not start this turn: Failed to read attachment 'a-b'.",
  summary: "The attachment file is missing.",
  driver: "codex",
  providerInstanceId: "codex",
  model: "gpt-5.1-codex",
  runtimeMode: "full-access",
  platform: "darwin arm64",
  serverVersion: "0.0.46",
} as const;

const parse = (url: string) => {
  const parsed = new URL(url);
  return { parsed, params: parsed.searchParams };
};

describe("buildProviderFailureReportUrl", () => {
  it("opens the bug form with the template's field ids filled in", () => {
    const url = buildProviderFailureReportUrl(base)!;
    const { parsed, params } = parse(url);

    assert.equal(parsed.origin + parsed.pathname, "https://github.com/pingdotgg/t3code/issues/new");
    assert.equal(params.get("template"), "bug_report.yml");
    assert.equal(
      params.get("title"),
      "[Bug]: The provider could not start this turn: Failed to read attachment.",
    );
    assert.equal(
      params.get("actual"),
      [
        "Error message:",
        "The provider could not start this turn: Failed to read attachment 'a-b'.",
        "",
        "What happened (explained by a text generation model, so it may be wrong):",
        "The attachment file is missing.",
      ].join("\n"),
    );
    assert.equal(
      params.get("environment"),
      "Provider: codex, Model: gpt-5.1-codex, Runtime mode: full-access, OS: darwin arm64",
    );
    assert.equal(params.get("version"), "0.0.46");
    assert.sameMembers(
      [...params.keys()],
      ["template", "title", "actual", "environment", "version"],
    );
  });

  it("percent-encodes every value so the form reads them back exactly", () => {
    const url = buildProviderFailureReportUrl({
      ...base,
      failureMessage: "Bad & broken: 100% #1 =x\nsecond line é",
    })!;
    assert.notInclude(url, " ");
    assert.notInclude(url, "\n");
    assert.include(url, "%26");
    assert.include(url, "%23");
    assert.include(parse(url).params.get("actual")!, "Bad & broken: 100% #1 =x\nsecond line é");
  });

  it("omits the version when the server does not know it", () => {
    const { params } = parse(buildProviderFailureReportUrl({ ...base, serverVersion: null })!);
    assert.isFalse(params.has("version"));
  });

  it("names the instance when the driver is unknown", () => {
    const { params } = parse(
      buildProviderFailureReportUrl({
        ...base,
        driver: null,
        providerInstanceId: "my-codex",
        model: null,
      })!,
    );
    assert.include(params.get("environment"), "Provider: my-codex, Model: unknown");
  });

  it("caps the link length by shortening the actual-behavior text first", () => {
    const url = buildProviderFailureReportUrl({
      ...base,
      failureMessage: `Failure ${"é&".repeat(20_000)}`,
      summary: "s".repeat(5_000),
    })!;
    const { params } = parse(url);

    assert.isAtMost(url.length, MAX_REPORT_URL_CHARS);
    assert.isTrue(params.get("actual")!.endsWith("..."));
    assert.isTrue(params.get("title")!.startsWith("[Bug]: Failure"));
    assert.isAtMost(params.get("title")!.length, 7 + 80);
    assert.equal(params.get("version"), "0.0.46");
    assert.include(params.get("environment"), "Runtime mode: full-access");
  });
});

describe("titleFromFailure", () => {
  it("drops ids, paths, URLs, quoted values, and T3 guidance", () => {
    assert.equal(
      titleFromFailure(
        "Failed to read '/Users/alex/.env' from https://example.com/x for 3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab at provider-turn:abc. Retry the turn; if it keeps failing, check the provider setup and server logs.",
      ),
      "Failed to read from for at",
    );
  });

  it("drops bearer credentials and digit-bearing keys", () => {
    const title = titleFromFailure("Rejected Bearer sk-ant-api03-abcdef by Anthropic (status 429)");
    assert.notInclude(title, "sk-ant");
    assert.notInclude(title, "abcdef");
  });

  it("cuts a long message to a title length", () => {
    const title = titleFromFailure(`Failure ${"word ".repeat(100)}`);
    assert.isAtMost(title.length, 80);
    assert.isTrue(title.endsWith("..."));
  });
});
