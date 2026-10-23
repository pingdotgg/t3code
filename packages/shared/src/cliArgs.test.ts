import { describe, expect, it } from "vite-plus/test";

import { parseCliArgs, tokenizeCliArgs } from "./cliArgs.ts";

describe("tokenizeCliArgs", () => {
  it("preserves escaped double quotes outside quoted values", () => {
    expect(tokenizeCliArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`)).toEqual([
      "--config",
      'model="gpt-6.1-sol"',
      "--strict-config",
    ]);
  });

  it("preserves escaped single quotes outside quoted values", () => {
    expect(tokenizeCliArgs(String.raw`--append-system-prompt don\'t --verbose`)).toEqual([
      "--append-system-prompt",
      "don't",
      "--verbose",
    ]);
  });

  it("preserves quoted values and escaped spaces", () => {
    expect(
      tokenizeCliArgs(
        String.raw`--config model="gpt 5" --enable foo\ bar --config=profile='work profile'`,
      ),
    ).toEqual(["--config", "model=gpt 5", "--enable", "foo bar", "--config=profile=work profile"]);
  });

  it("preserves literal backslashes in path values", () => {
    expect(
      tokenizeCliArgs(String.raw`--config cacheDir=C:\Users\me --config "quoted=C:\Users\me"`),
    ).toEqual([
      "--config",
      String.raw`cacheDir=C:\Users\me`,
      "--config",
      String.raw`quoted=C:\Users\me`,
    ]);
  });
});

describe("parseCliArgs", () => {
  it("parses --key=value mixed with boolean flags", () => {
    expect(parseCliArgs("--chrome --model=claude-sonnet-4-6 --debug")).toEqual({
      flags: { chrome: null, model: "claude-sonnet-4-6", debug: null },
      positionals: [],
    });
  });

  it("collects positionals mixed with flags (argv array)", () => {
    expect(parseCliArgs(["1.2.3", "--root", "/path", "--github-output"])).toEqual({
      flags: { root: "/path", "github-output": null },
      positionals: ["1.2.3"],
    });
  });

  it("ignores bare -- with no flag name", () => {
    expect(parseCliArgs("--")).toEqual({ flags: {}, positionals: [] });
  });

  it("boolean flag does not consume next token as value", () => {
    expect(parseCliArgs(["--github-output", "1.2.3"], { booleanFlags: ["github-output"] })).toEqual(
      {
        flags: { "github-output": null },
        positionals: ["1.2.3"],
      },
    );
  });
});
