import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import { runBuildChild } from "../../core/BuildChild.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)));

/**
 * Copy `fixtures/vinext` into a scratch directory inside it, so the build
 * resolves the fixture's own `node_modules`.
 */
const fixture = (options: { readonly prerender: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* path.fromFileUrl(new URL("../../../fixtures/vinext/", import.meta.url));
    const root = yield* fs.makeTempDirectoryScoped({ directory: source, prefix: ".vinext-test-" });
    for (const entry of ["app", "worker", "package.json", "vite.config.ts"]) {
      yield* fs.copy(path.join(source, entry), path.join(root, entry));
    }
    if (options.prerender) {
      const config = path.join(root, "vite.config.ts");
      yield* fs.writeFileString(
        config,
        (yield* fs.readFileString(config)).replace("vinext()", "vinext({ prerender: true })"),
      );
    }
    return root;
  });

const build = (root: string, main: string) =>
  runBuildChild({
    module: new URL("../source.ts", import.meta.url).href,
    rootDir: root,
    framework: "vinext",
    config: {
      rootDir: root,
      main,
      compatibilityDate: "2026-08-31",
      compatibilityFlags: ["nodejs_compat"],
    },
  });

describe("vinext Cloudflare build", () => {
  it(
    "uploads the Worker main, not vinext's own rsc entry, as the entry module",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* fixture({ prerender: false });
          const output = yield* build(root, "worker/server.ts");
          const names = output.serverModules?.map((module) => module.name) ?? [];
          // The Worker main builds as `index`, the entry chunk name of
          // `@cloudflare/vite-plugin`, in place of the `index` entry vinext's
          // rsc environment declares: the one top-level entry uploaded first
          // is the main (`worker/server.ts`, its default export a `fetch`
          // wrapper), and vinext's app entry is bundled into its chunks.
          const entries = names.filter(
            (name) =>
              /^dist\/server\/[^/]+\.js$/.test(name) && !/__|vinext-client-assets/.test(name),
          );
          expect(entries).toEqual(["dist/server/index.js"]);
          expect(names[0]).toBe("dist/server/index.js");
          // (Source maps are on by default, as with `@cloudflare/vite-plugin`.)
          expect(
            String(output.serverModules?.[0]?.content).replace(
              /\n\/\/# sourceMappingURL=.*\n?$/,
              "",
            ),
          ).toMatch(
            /\{fetch\(\w+,\w+,\w+\)\{return \w+\.fetch\(\w+,\w+,\w+\)\}\};export\{\w+ as default\};$/,
          );
        }),
      ),
    300_000,
  );

  it(
    "collects modules vinext writes after the bundle, imported from non-entry chunks",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fixture({ prerender: false });
          const output = yield* build(root, "worker/server.ts");
          const manifest = "dist/server/__vinext_action_owner_manifest.js";
          expect(yield* fs.exists(path.join(root, manifest))).toBe(true);
          expect(output.serverModules?.map((module) => module.name)).toContain(manifest);
        }),
      ),
    300_000,
  );

  it(
    "uploads server modules as rewritten by prerendering, not as bundled",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fixture({ prerender: true });
          const output = yield* build(root, "worker/index.ts");
          const stale: Array<string> = [];
          for (const module of output.serverModules ?? []) {
            if (!module.name.endsWith(".js")) continue;
            const onDisk = yield* fs.readFileString(path.join(root, module.name));
            if (onDisk !== Buffer.from(module.content).toString()) stale.push(module.name);
          }
          expect(stale).toEqual([]);
        }),
      ),
    300_000,
  );
});
