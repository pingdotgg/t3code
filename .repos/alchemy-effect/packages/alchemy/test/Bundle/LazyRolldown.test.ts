import { exec } from "@/Util/exec.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath } from "node:url";

/**
 * Regression tests for #562: importing alchemy's CLI or provider modules
 * must never load rolldown's native binding (`@rolldown/binding-*`). A
 * user whose stack bundles nothing (e.g. a non-Cloudflare stack running
 * `alchemy deploy`) must not require the native bundler to be loadable.
 *
 * Each entry is imported in a fresh subprocess — the single-process test
 * runner has long since loaded rolldown for other suites, so the check
 * can only be made in an isolated module registry. `process.dlopen` is
 * the choke point every native-addon load goes through, so intercepting
 * it detects the binding no matter which package (`rolldown`,
 * `rolldown/parseAst`, `@alchemy.run/cloudflare-runtime/rolldown`)
 * pulled it in.
 */

const entries = [
  "src/Bundle/index.ts",
  "src/Cli/main.ts",
  "src/Cloudflare/index.ts",
] as const;

const importInSubprocess = (entry: string) => {
  const entryPath = fileURLToPath(new URL(`../../${entry}`, import.meta.url));
  const script = `
    const orig = process.dlopen;
    const loaded = [];
    process.dlopen = function (mod, path, ...rest) {
      loaded.push(path);
      return orig.call(process, mod, path, ...rest);
    };
    await import(${JSON.stringify(entryPath)});
    const hits = loaded.filter((p) => p.includes("rolldown"));
    if (hits.length > 0) {
      console.error("rolldown native binding loaded by:\\n" + hits.join("\\n"));
      process.exit(1);
    }
    console.log("no rolldown native binding loaded");
  `;
  return exec(
    ChildProcess.make(process.execPath, ["-e", script], { shell: false }),
  ).pipe(Effect.scoped);
};

describe("lazy rolldown (#562)", () => {
  for (const entry of entries) {
    it.effect(
      `importing ${entry} does not load rolldown's native binding`,
      () =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* importInSubprocess(entry);
          expect(stderr).toBe("");
          expect(stdout).toContain("no rolldown native binding loaded");
          expect(exitCode).toBe(0);
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
