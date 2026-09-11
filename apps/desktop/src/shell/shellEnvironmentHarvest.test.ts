import { assert, describe, it } from "@effect/vitest";

import {
  isImportableEnvironmentName,
  normalizeShellEnvironmentMode,
  normalizeShellEnvironmentNames,
} from "./shellEnvironmentHarvest.ts";

describe("shellEnvironmentHarvest", () => {
  it("rejects names that would escape the probe command", () => {
    assert.equal(isImportableEnvironmentName("OPENAI_API_KEY"), true);
    assert.equal(isImportableEnvironmentName("_PRIVATE"), true);
    assert.equal(isImportableEnvironmentName("FOO; rm -rf /"), false);
    assert.equal(isImportableEnvironmentName("FOO'"), false);
    assert.equal(isImportableEnvironmentName("$(id)"), false);
    assert.equal(isImportableEnvironmentName("FOO=BAR"), false);
    assert.equal(isImportableEnvironmentName("1FOO"), false);
    assert.equal(isImportableEnvironmentName(""), false);
  });

  it("rejects names that describe the running process", () => {
    for (const name of ["HOME", "PWD", "OLDPWD", "SHLVL", "_"]) {
      assert.equal(isImportableEnvironmentName(name), false);
    }
  });

  it("normalizes configured names and drops unusable entries", () => {
    assert.deepEqual(
      normalizeShellEnvironmentNames([
        " OPENAI_API_KEY ",
        "OPENAI_API_KEY",
        "FOO; rm -rf /",
        "HOME",
        42,
        "",
        "CARGO_HOME",
      ]),
      ["OPENAI_API_KEY", "CARGO_HOME"],
    );
    assert.deepEqual(normalizeShellEnvironmentNames("OPENAI_API_KEY"), []);
    assert.deepEqual(normalizeShellEnvironmentNames(undefined), []);
  });

  it("falls back to the allowlist for unrecognized modes", () => {
    assert.equal(normalizeShellEnvironmentMode("all"), "all");
    assert.equal(normalizeShellEnvironmentMode("allowlist"), "allowlist");
    assert.equal(normalizeShellEnvironmentMode("everything"), "allowlist");
    assert.equal(normalizeShellEnvironmentMode(undefined), "allowlist");
  });
});
