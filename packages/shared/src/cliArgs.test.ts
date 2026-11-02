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

    for (const whitespace of [" ", "\t"]) {
      const args = `--add-dir /tmp/project\\${whitespace}`;
      expect(tokenizeCliArgs(args)).toEqual(["--add-dir", `/tmp/project${whitespace}`]);
      expect(tokenizeCliArgs(`${args} --verbose`)).toEqual([
        "--add-dir",
        `/tmp/project${whitespace}`,
        "--verbose",
      ]);
    }
  });

  it("ignores unescaped surrounding whitespace", () => {
    expect(tokenizeCliArgs(" \t\n")).toEqual([]);
    expect(tokenizeCliArgs(" \t--add-dir /tmp/project \t\n")).toEqual([
      "--add-dir",
      "/tmp/project",
    ]);
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

  it("accepts a trailing -- without operands", () => {
    expect(parseCliArgs("--")).toEqual({ flags: {}, positionals: [] });
  });

  it.each([
    { args: "--effort low -- --effort high --chrome" },
    { args: ["--effort", "low", "--", "--effort", "high", "--chrome"] },
  ])("ends option parsing at -- for $args", ({ args }) => {
    expect(parseCliArgs(args)).toEqual({
      flags: { effort: "low" },
      positionals: ["--effort", "high", "--chrome"],
    });
  });

  it("preserves all operands after --, including empty strings and another --", () => {
    expect(parseCliArgs(["--", "", "--", "--model=example", "-x"])).toEqual({
      flags: {},
      positionals: ["", "--", "--model=example", "-x"],
    });
  });

  it("ends option parsing with explicit boolean flags too", () => {
    expect(parseCliArgs(["--chrome", "--", "--verbose"], { booleanFlags: ["chrome"] })).toEqual({
      flags: { chrome: null },
      positionals: ["--verbose"],
    });
  });

  it("keeps -- inside an equals-form option value", () => {
    expect(parseCliArgs("--append-system-prompt=-- --chrome")).toEqual({
      flags: { "append-system-prompt": "--", chrome: null },
      positionals: [],
    });
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
