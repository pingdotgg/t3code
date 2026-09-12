import { describe, expect, test } from "bun:test";
import { parseOutputUrl, parseOutputValue } from "../src/DevCli.ts";

describe("parseOutputUrl", () => {
  test("parses aligned and legacy stack output formats", () => {
    expect(
      parseOutputUrl("  api      http://api.localhost:1234/\n", "api"),
    ).toBe("http://api.localhost:1234/");
    expect(parseOutputUrl('api: "https://example.com/path"\n', "api")).toBe(
      "https://example.com/path",
    );
    expect(
      parseOutputUrl(
        '{\n  api: "http://api.localhost:1234/",\n  stage: "dev",\n}\n',
        "api",
      ),
    ).toBe("http://api.localhost:1234/");
  });

  test("matches exact keys and waits for a complete output line", () => {
    expect(
      parseOutputUrl("otherApi http://wrong.example/\n", "api"),
    ).toBeUndefined();
    expect(
      parseOutputUrl("api http://partial.example/", "api"),
    ).toBeUndefined();
  });
});

describe("parseOutputValue", () => {
  test("parses aligned and legacy scalar output formats", () => {
    expect(parseOutputValue("  account      000000000000\n", "account")).toBe(
      "000000000000",
    );
    expect(parseOutputValue('text: "seed-object-body-v1"\n', "text")).toBe(
      "seed-object-body-v1",
    );
  });

  test("matches exact keys", () => {
    expect(parseOutputValue("seedAccount 000000000000\n", "account")).toBe(
      undefined,
    );
  });
});
