import { describe, expect, it } from "vite-plus/test";

import {
  detectedScriptsFromComposerJson,
  detectedScriptsFromPackageJson,
} from "./usePackageManagerScripts";

describe("detectedScriptsFromPackageJson", () => {
  it("maps each script to an `npm run <name>` command", () => {
    const contents = JSON.stringify({ scripts: { test: "vitest run", build: "tsc -b" } });

    expect(detectedScriptsFromPackageJson(contents)).toEqual([
      { name: "test", command: "npm run test", source: "npm" },
      { name: "build", command: "npm run build", source: "npm" },
    ]);
  });

  it("returns an empty list when scripts is missing", () => {
    expect(detectedScriptsFromPackageJson(JSON.stringify({ name: "pkg" }))).toEqual([]);
  });

  it("returns an empty list when scripts is not an object", () => {
    expect(detectedScriptsFromPackageJson(JSON.stringify({ scripts: ["test"] }))).toEqual([]);
    expect(detectedScriptsFromPackageJson(JSON.stringify({ scripts: "test" }))).toEqual([]);
  });

  it("returns an empty list for malformed JSON", () => {
    expect(detectedScriptsFromPackageJson("{not json")).toEqual([]);
  });
});

describe("detectedScriptsFromComposerJson", () => {
  it("maps each script to a `composer run-script <name>` command", () => {
    const contents = JSON.stringify({ scripts: { test: "phpunit", lint: "phpcs" } });

    expect(detectedScriptsFromComposerJson(contents)).toEqual([
      { name: "test", command: "composer run-script test", source: "composer" },
      { name: "lint", command: "composer run-script lint", source: "composer" },
    ]);
  });

  it("supports composer's array-valued script commands", () => {
    const contents = JSON.stringify({ scripts: { check: ["phpcs", "phpstan"] } });

    expect(detectedScriptsFromComposerJson(contents)).toEqual([
      { name: "check", command: "composer run-script check", source: "composer" },
    ]);
  });

  it("returns an empty list when scripts is missing", () => {
    expect(detectedScriptsFromComposerJson(JSON.stringify({ name: "pkg" }))).toEqual([]);
  });

  it("returns an empty list for malformed JSON", () => {
    expect(detectedScriptsFromComposerJson("{not json")).toEqual([]);
  });
});
