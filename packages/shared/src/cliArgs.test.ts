import { describe, expect, it } from "vitest";

import { parseCliArgs } from "./cliArgs.ts";

describe("parseCliArgs", () => {
  it("returns empty result for empty string", () => {
    expect(parseCliArgs("")).toEqual({ flags: {}, positionals: [] });
  });

  it("returns empty result for whitespace-only string", () => {
    expect(parseCliArgs("   ")).toEqual({ flags: {}, positionals: [] });
  });

  it("returns empty result for empty array", () => {
    expect(parseCliArgs([])).toEqual({ flags: {}, positionals: [] });
  });

  it("parses --chrome boolean flag", () => {
    expect(parseCliArgs("--chrome")).toEqual({
      flags: { chrome: null },
      positionals: [],
    });
  });

  it("parses --chrome with --verbose", () => {
    expect(parseCliArgs("--chrome --verbose")).toEqual({
      flags: { chrome: null, verbose: null },
      positionals: [],
    });
  });

  it("parses --effort with a value", () => {
    expect(parseCliArgs("--effort high")).toEqual({
      flags: { effort: "high" },
      positionals: [],
    });
  });

  it("parses --chrome --effort high --debug", () => {
    expect(parseCliArgs("--chrome --effort high --debug")).toEqual({
      flags: { chrome: null, effort: "high", debug: null },
      positionals: [],
    });
  });

  it("parses --model with full model name", () => {
    expect(parseCliArgs("--model claude-sonnet-4-6")).toEqual({
      flags: { model: "claude-sonnet-4-6" },
      positionals: [],
    });
  });

  it("parses --append-system-prompt with value and --chrome", () => {
    expect(parseCliArgs("--append-system-prompt always-think-step-by-step --chrome")).toEqual({
      flags: { "append-system-prompt": "always-think-step-by-step", chrome: null },
      positionals: [],
    });
  });

  it("parses --max-budget-usd with numeric value", () => {
    expect(parseCliArgs("--chrome --max-budget-usd 5.00")).toEqual({
      flags: { chrome: null, "max-budget-usd": "5.00" },
      positionals: [],
    });
  });

  it("parses --effort=high syntax", () => {
    expect(parseCliArgs("--effort=high")).toEqual({
      flags: { effort: "high" },
      positionals: [],
    });
  });

  it("parses --key=value mixed with boolean flags", () => {
    expect(parseCliArgs("--chrome --model=claude-sonnet-4-6 --debug")).toEqual({
      flags: { chrome: null, model: "claude-sonnet-4-6", debug: null },
      positionals: [],
    });
  });

  it("collects positional arguments", () => {
    expect(parseCliArgs("1.2.3")).toEqual({
      flags: {},
      positionals: ["1.2.3"],
    });
  });

  it("collects positionals mixed with flags (argv array)", () => {
    expect(parseCliArgs(["1.2.3", "--root", "/path", "--github-output"])).toEqual({
      flags: { root: "/path", "github-output": null },
      positionals: ["1.2.3"],
    });
  });

  it("handles extra whitespace between tokens", () => {
    expect(parseCliArgs("  --chrome   --verbose  ")).toEqual({
      flags: { chrome: null, verbose: null },
      positionals: [],
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

  it("non-boolean flag still consumes next token", () => {
    expect(parseCliArgs(["--root", "/path", "1.2.3"], { booleanFlags: ["github-output"] })).toEqual(
      {
        flags: { root: "/path" },
        positionals: ["1.2.3"],
      },
    );
  });

  it("mixes boolean and value flags with positionals", () => {
    expect(
      parseCliArgs(["--github-output", "--root", "/path", "1.2.3"], {
        booleanFlags: ["github-output"],
      }),
    ).toEqual({
      flags: { "github-output": null, root: "/path" },
      positionals: ["1.2.3"],
    });
  });
});
