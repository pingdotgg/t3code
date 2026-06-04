import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { codexAppServerArgs, codexExecLaunchArgs } from "./CodexProvider.ts";

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    assert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends whitespace-split launch args after app-server", () => {
    assert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    assert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt-5"'),
      ["--strict-config", "--enable", "foo", "--config", 'model="gpt-5"'],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    assert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
