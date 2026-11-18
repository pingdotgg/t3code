import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("watchImport", () => {
  it("transforms TypeScript, tracks dependencies, and reloads the whole graph", () => {
    const temporaryDirectory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alchemy-import-")));
    temporaryDirectories.push(temporaryDirectory);
    const directory = path.join(temporaryDirectory, "project");
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, "entry.ts"),
      [
        'import { count, text } from "./dependency.js";',
        'import { externalCount } from "../external.js";',
        "interface Result { count: number; externalCount: number; text: string }",
        "export const result: Result = { count, externalCount, text };",
      ].join("\n"),
    );
    writeFileSync(
      path.join(directory, "dependency.ts"),
      [
        "const state = globalThis as typeof globalThis & { calls?: number };",
        "export const count = state.calls = (state.calls ?? 0) + 1;",
        'export const text: string = "__VALUE__";',
      ].join("\n"),
    );
    const external = path.join(temporaryDirectory, "external.ts");
    writeFileSync(
      external,
      [
        "const state = globalThis as typeof globalThis & { externalCalls?: number };",
        "export const externalCount = state.externalCalls = (state.externalCalls ?? 0) + 1;",
      ].join("\n"),
    );

    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dir, "../src/watch/import-watcher.ts"),
    ).href;
    const registerUrl = pathToFileURL(
      path.resolve(import.meta.dir, "../src/loader/register.ts"),
    ).href;
    const script = `
      import { writeFile } from "node:fs/promises";
      import { fileURLToPath, pathToFileURL } from "node:url";
      import { watchImport } from ${JSON.stringify(moduleUrl)};
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc();

      const directory = process.argv[1];
      const dependency = directory + "/dependency.ts";
      const external = fileURLToPath(new URL("../external.ts", pathToFileURL(directory + "/")));
      const watcher = watchImport("./entry.ts", {
        parentURL: pathToFileURL(directory + "/runner.mjs").href,
        debounceMs: 10,
        shouldInvalidate: url =>
          url.startsWith("file:") && fileURLToPath(url).startsWith(process.argv[2] + "/"),
      });
      const first = await watcher.import();
      if (first.value.result.count !== 1) throw new Error("first graph was not evaluated");
      if (first.value.result.externalCount !== 1) throw new Error("external module was not evaluated");
      if (!first.dependencies.has(directory + "/entry.ts")) throw new Error("entry was not tracked");
      if (!first.dependencies.has(dependency)) throw new Error("dependency was not tracked");
      if (!first.dependencies.has(external)) throw new Error("sibling project module was not tracked");

      let unchangedEvents = 0;
      const unsubscribeUnchanged = watcher.subscribe(() => unchangedEvents++);
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(dependency, [
        "const state = globalThis as typeof globalThis & { calls?: number };",
        "export const count = state.calls = (state.calls ?? 0) + 1;",
        'export const text: string = "__VALUE__";',
      ].join("\\n"));
      await new Promise(resolve => setTimeout(resolve, 100));
      unsubscribeUnchanged();
      if (unchangedEvents !== 0) throw new Error("unchanged contents triggered a reload");

      const changed = new Promise(resolve => watcher.subscribe(resolve));
      await writeFile(dependency, [
        "const state = globalThis as typeof globalThis & { calls?: number };",
        "export const count = state.calls = (state.calls ?? 0) + 1;",
        'export const text: string = "changed";',
      ].join("\\n"));
      let timeout;
      const event = await Promise.race([
        changed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("watch timed out")), 3000);
        }),
      ]);
      clearTimeout(timeout);
      if (!event.paths.has(dependency)) throw new Error("change path was not reported");

      const second = await watcher.import();
      if (second.value.result.count !== 2) throw new Error("dependency graph was not cache busted");
      if (second.value.result.externalCount !== 2) throw new Error("sibling project module was not cache busted");
      if (second.value.result.text !== "changed") throw new Error("changed module was not loaded");
      if (first.namespace === second.namespace) throw new Error("generation namespace was reused");
      await watcher.close();
    `;

    const result = spawnSync(
      "node",
      ["--no-warnings", "--input-type=module", "-e", script, directory, temporaryDirectory],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("standalone: follows a member's require() calls, refreshes them and enables source maps", () => {
    const temporaryDirectory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alchemy-import-")));
    temporaryDirectories.push(temporaryDirectory);
    const directory = path.join(temporaryDirectory, "project");
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, "entry.ts"),
      ['import lib from "./lib.cjs";', "export const result: { n: number; h: number } = lib;"].join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(directory, "lib.cts"),
      [
        'const helper: { h: number } = require("./helper.cjs");',
        "const state = globalThis as typeof globalThis & { libCalls?: number };",
        "const n: number = (state.libCalls = (state.libCalls ?? 0) + 1);",
        "module.exports = { n, h: helper.h };",
      ].join("\n"),
    );
    writeFileSync(
      path.join(directory, "helper.cts"),
      [
        "const state = globalThis as typeof globalThis & { helperCalls?: number };",
        "const h: number = (state.helperCalls = (state.helperCalls ?? 0) + 1);",
        "module.exports = { h };",
      ].join("\n"),
    );

    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dir, "../src/watch/import-watcher.ts"),
    ).href;
    // No `registerOxc()`: the watcher is the only loader in this process.
    const script = `
      import { getSourceMapsSupport } from "node:module";
      import { pathToFileURL } from "node:url";
      import { watchImport } from ${JSON.stringify(moduleUrl)};

      const directory = process.argv[1];
      const members = ["entry.ts", "lib.cts", "helper.cts"].map(file => directory + "/" + file);
      if (getSourceMapsSupport().enabled) throw new Error("source maps were already on");
      const watcher = watchImport("./entry.ts", {
        parentURL: pathToFileURL(directory + "/runner.mjs").href,
        debounceMs: 10,
      });

      const first = await watcher.import();
      if (!getSourceMapsSupport().enabled) throw new Error("source maps were not enabled");
      for (const file of members) {
        if (!first.dependencies.has(file)) throw new Error(file + " was not tracked");
      }
      if (first.value.result.n !== 1 || first.value.result.h !== 1) throw new Error("first graph was not evaluated");

      const second = await watcher.import();
      for (const file of members) {
        if (!second.dependencies.has(file)) throw new Error(file + " was not tracked again");
      }
      if (second.value.result.n !== 2) throw new Error("CommonJS member was not re-evaluated");
      if (second.value.result.h !== 2) throw new Error("required CommonJS member was not re-evaluated");

      await watcher.close();
      if (getSourceMapsSupport().enabled) throw new Error("source maps were not restored");
    `;

    const result = spawnSync(
      "node",
      ["--no-warnings", "--input-type=module", "-e", script, directory],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
