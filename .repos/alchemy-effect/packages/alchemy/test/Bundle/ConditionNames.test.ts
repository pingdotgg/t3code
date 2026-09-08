import * as Bundle from "@/Bundle/Bundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Rolldown's default `resolve.conditionNames` are import-kind specific
 * (`import` for `import` statements, `require` for `require()` calls). An
 * explicit list is applied as one set to BOTH kinds, so listing `"import"`
 * makes every `require()` also match a package's `"import"` export — and
 * `exports` maps resolve in the PACKAGE's key order. `pg-pool` lists
 * `import` before `require`, so `pg`'s `require("pg-pool")` received the
 * ESM namespace and died with `TypeError: The superclass is not a
 * constructor`. {@link Bundle.BUN_CONDITION_NAMES} /
 * {@link Bundle.NODE_CONDITION_NAMES} leave the kind to rolldown.
 */
layer(NodeServices.layer)("bundle conditionNames", (it) => {
  /**
   * A dual package shaped like `pg-pool`: `import` listed first, each
   * entry carrying a distinct marker so the bundle shows which one a
   * given import kind resolved.
   */
  const project = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "alchemy-conditions-" });
    const pkg = path.join(root, "node_modules", "dual-pkg");
    yield* fs.makeDirectory(pkg, { recursive: true });
    yield* fs.writeFileString(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "dual-pkg",
        exports: { ".": { import: "./esm.mjs", require: "./cjs.cjs" } },
      }),
    );
    yield* fs.writeFileString(
      path.join(pkg, "esm.mjs"),
      `export const kind = "DUAL_PKG_ESM_ENTRY";\n`,
    );
    yield* fs.writeFileString(
      path.join(pkg, "cjs.cjs"),
      `module.exports = { kind: "DUAL_PKG_CJS_ENTRY" };\n`,
    );
    // A CommonJS consumer (what `pg` is) requiring the dual package…
    yield* fs.writeFileString(
      path.join(root, "consumer.cjs"),
      `module.exports = { viaRequire: require("dual-pkg").kind };\n`,
    );
    // …and an ESM entry importing it directly as well.
    const entry = path.join(root, "entry.mjs");
    yield* fs.writeFileString(
      entry,
      `import { kind as viaImport } from "dual-pkg";\nimport consumer from "./consumer.cjs";\nexport default { viaImport, viaRequire: consumer.viaRequire };\n`,
    );
    return { root, entry };
  });

  const bundleWith = (conditionNames: readonly string[]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, entry } = yield* project;
      try {
        const result = yield* Bundle.build(
          {
            cwd: root,
            input: entry,
            platform: "node",
            resolve: { conditionNames: [...conditionNames] },
          },
          { format: "esm" },
        );
        return result.files
          .filter((file) => typeof file.content === "string")
          .map((file) => file.content as string)
          .join("\n");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    });

  it.effect(
    "BUN_CONDITION_NAMES: require() resolves the CJS export, import the ESM one",
    () =>
      Effect.gen(function* () {
        const code = yield* bundleWith(Bundle.BUN_CONDITION_NAMES);
        expect(code).toContain("DUAL_PKG_CJS_ENTRY");
        expect(code).toContain("DUAL_PKG_ESM_ENTRY");
      }),
  );

  it.effect(
    "NODE_CONDITION_NAMES: require() resolves the CJS export, import the ESM one",
    () =>
      Effect.gen(function* () {
        const code = yield* bundleWith(Bundle.NODE_CONDITION_NAMES);
        expect(code).toContain("DUAL_PKG_CJS_ENTRY");
        expect(code).toContain("DUAL_PKG_ESM_ENTRY");
      }),
  );

  // The control: the former list, with `"import"` baked in, hands the CJS
  // consumer's require() the ESM entry — the `pg` crash.
  it.effect("a list containing `import` mis-resolves require() to ESM", () =>
    Effect.gen(function* () {
      const code = yield* bundleWith(["bun", "import", "module", "default"]);
      expect(code).not.toContain("DUAL_PKG_CJS_ENTRY");
      expect(code).toContain("DUAL_PKG_ESM_ENTRY");
    }),
  );
});
