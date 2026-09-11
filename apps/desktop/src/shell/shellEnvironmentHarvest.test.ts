import { assert, describe, it } from "@effect/vitest";

import {
  isImportableEnvironmentName,
  normalizeShellEnvironmentMode,
  normalizeShellEnvironmentNames,
} from "./shellEnvironmentHarvest.ts";

describe("shellEnvironmentHarvest", () => {
  it("rejects names that would escape the probe command", () => {
    assert.equal(isImportableEnvironmentName("OPENAI_API_KEY", "linux"), true);
    assert.equal(isImportableEnvironmentName("_PRIVATE", "linux"), true);
    assert.equal(isImportableEnvironmentName("FOO; rm -rf /", "linux"), false);
    assert.equal(isImportableEnvironmentName("FOO'", "linux"), false);
    assert.equal(isImportableEnvironmentName("$(id)", "linux"), false);
    assert.equal(isImportableEnvironmentName("FOO=BAR", "linux"), false);
    assert.equal(isImportableEnvironmentName("1FOO", "linux"), false);
    assert.equal(isImportableEnvironmentName("", "linux"), false);
  });

  it("rejects names that describe the running process", () => {
    for (const name of ["HOME", "PWD", "OLDPWD", "SHLVL", "_"]) {
      assert.equal(isImportableEnvironmentName(name, "linux"), false);
    }
  });

  it("normalizes configured names and drops unusable entries", () => {
    assert.deepEqual(
      normalizeShellEnvironmentNames(
        [" OPENAI_API_KEY ", "OPENAI_API_KEY", "FOO; rm -rf /", "HOME", 42, "", "CARGO_HOME"],
        "linux",
      ),
      ["OPENAI_API_KEY", "CARGO_HOME"],
    );
    assert.deepEqual(normalizeShellEnvironmentNames("OPENAI_API_KEY", "linux"), []);
    assert.deepEqual(normalizeShellEnvironmentNames(undefined, "linux"), []);
  });

  it("falls back to the allowlist for unrecognized modes", () => {
    assert.equal(normalizeShellEnvironmentMode("all"), "all");
    assert.equal(normalizeShellEnvironmentMode("allowlist"), "allowlist");
    assert.equal(normalizeShellEnvironmentMode("everything"), "allowlist");
    assert.equal(normalizeShellEnvironmentMode(undefined), "allowlist");
  });

  it("rejects reserved names case-insensitively on Windows only", () => {
    assert.equal(isImportableEnvironmentName("pwd", "win32"), false);
    assert.equal(isImportableEnvironmentName("Path", "win32"), true);
    assert.equal(isImportableEnvironmentName("home", "win32"), false);
    assert.equal(isImportableEnvironmentName("pwd", "linux"), true);
    assert.equal(isImportableEnvironmentName("home", "linux"), true);
  });

  it("deduplicates configured names by their Windows casing", () => {
    assert.deepEqual(normalizeShellEnvironmentNames(["Path", "PATH"], "win32"), ["Path"]);
    assert.deepEqual(normalizeShellEnvironmentNames(["Path", "PATH"], "linux"), ["Path", "PATH"]);
    assert.deepEqual(normalizeShellEnvironmentNames(["pwd"], "win32"), []);
  });
});
