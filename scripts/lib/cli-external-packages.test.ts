import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import {
  CLI_RUNTIME_EXTERNAL_PREFIXES,
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";

// Only the field this test cares about; decoding ignores everything else.
// optionalDependencies matter as much as dependencies here: every native family
// in the list declares its actual platform bindings there (ffi-rs -> @yuuang/*,
// msgpackr-extract -> @msgpackr-extract/*, fff-node -> @ff-labs/fff-bin-*), so
// reading only `dependencies` would check nothing for exactly those packages.
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type PackageManifest = typeof PackageManifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

describe("shouldBundleCliDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of ["effect", "@effect/platform", "hono", "@t3tools/shared/hostProcess"]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@clerk/electron-passkeys",
      "msgpackr-extract",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  it("leaves bun-only entry points external", () => {
    assert.strictEqual(shouldBundleCliDependency("@effect/platform-bun"), false);
    assert.strictEqual(shouldBundleCliDependency("@effect/sql-sqlite-bun"), false);
  });

  // The real package is `node-gyp-build-optional-packages`, reached by prefix.
  // It is transitive to a selected dependency root, so the runtime closure test
  // below ensures it follows that root into the sidecar.
  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("selectCliRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@effect/platform-bun": "1.0.0",
        "@ff-labs/fff-node": "2.0.0",
        effect: "3.0.0",
        "node-pty": "4.0.0",
      }),
      {
        "@ff-labs/fff-node": "2.0.0",
        "node-pty": "4.0.0",
      },
    );
  });

  it("selects every external root declared by the server", () => {
    assert.deepStrictEqual(
      Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
      ["@ff-labs/fff-node", "msgpackr-extract", "node-pty"],
    );
  });
});

// An external package is loaded from the real filesystem, so its own `require`
// also resolves from the real filesystem. If one of its dependencies was
// bundled away instead of left external, that dependency does not follow the
// selected root into the sidecar.
//
// Found the hard way: node-gyp-build-optional-packages requires detect-libc,
// which was bundled. Windows was fine; WSL got MODULE_NOT_FOUND.
it.layer(NodeServices.layer)("external package dependency closure", (it) => {
  // Read manifests off disk from the pnpm store rather than resolving them.
  // `require("<name>/package.json")` cannot do this job: under pnpm isolation a
  // transitive package (detect-libc, msgpackr-extract, ffi-rs) is not reachable
  // by name from this file at all, and an `exports` map can refuse the
  // `/package.json` subpath outright (@ff-labs/fff-node). Both surface as "not
  // installed", which would let this test skip everything and pass while
  // checking nothing. The store contains the dependency graph the sidecar's
  // minimal production install resolves.
  const readInstalledPackages = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storeDir = path.resolve(
      path.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../node_modules/.pnpm",
    );

    // The store holds regular files too (lock.yaml), so a path built under one
    // raises ENOTDIR rather than reporting absence. That throws on Linux while
    // Windows quietly returns false, which is exactly the kind of difference
    // this test exists to catch, so treat any failure as "not there".
    const isPresent = (candidate: string) =>
      fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

    const installed = new Map<string, PackageManifest>();
    if (!(yield* isPresent(storeDir))) return installed;

    for (const entry of yield* fileSystem.readDirectory(storeDir)) {
      const modulesDir = path.join(storeDir, entry, "node_modules");
      if (!(yield* isPresent(modulesDir))) continue;

      for (const owner of yield* fileSystem.readDirectory(modulesDir)) {
        const names = owner.startsWith("@")
          ? (yield* fileSystem.readDirectory(path.join(modulesDir, owner))).map(
              (scoped) => `${owner}/${scoped}`,
            )
          : [owner];

        for (const name of names) {
          if (installed.has(name)) continue;
          const manifestPath = path.join(modulesDir, name, "package.json");
          if (!(yield* isPresent(manifestPath))) continue;
          installed.set(name, decodeManifest(yield* fileSystem.readFileString(manifestPath)));
        }
      }
    }
    return installed;
  }).pipe(Effect.cached, Effect.runSync);

  // Runtime-external only. The build-only entries resolve `bun:*` and are never
  // loaded by Node, so their closure genuinely does not need to be external.
  const isRuntimeExternal = (name: string) =>
    CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix));

  // A cold walk of the pnpm store can exceed the root timeout when the Windows
  // lane runs four filesystem-heavy workspace suites at once.
  it.effect(
    "finds the runtime-external packages on disk",
    () =>
      Effect.gen(function* () {
        const installed = yield* readInstalledPackages;
        const found = [...installed.keys()].filter(isRuntimeExternal);

        // Without this the closure check below can pass vacuously: if nothing is
        // read, nothing is checked. These are the packages whose closure actually
        // broke WSL, so require them by name.
        for (const required of ["node-pty", "node-gyp-build-optional-packages", "detect-libc"]) {
          assert.ok(
            found.includes(required),
            `expected ${required} in the pnpm store; the closure check is only meaningful if it can read these (found ${found.length})`,
          );
        }
      }),
    120_000,
  );

  it.effect("keeps every runtime dependency of an external package external too", () =>
    Effect.gen(function* () {
      const installed = yield* readInstalledPackages;
      const violations: string[] = [];
      const seen = new Set<string>();
      // Seeded from what is actually installed and matches a prefix, so scoped
      // prefixes like "@yuuang/" and "@ff-labs/" are covered too. Seeding from
      // the prefix strings themselves would skip every scoped entry, since a
      // prefix is not a package name.
      const queue = [...installed.keys()].filter(isRuntimeExternal);

      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);

        const manifest = installed.get(name);
        if (!manifest) continue;

        const declared = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        };
        for (const dependency of Object.keys(declared)) {
          if (!isRuntimeExternal(dependency)) {
            violations.push(`${name} -> ${dependency}`);
          }
          if (!seen.has(dependency)) queue.push(dependency);
        }
      }

      assert.deepStrictEqual(
        violations,
        [],
        `these dependencies of external packages would be bundled away and fail to resolve under WSL: ${violations.join(", ")}`,
      );
    }),
  );
});

// Configuring the bundler is not the same as checking what it emitted. These
// exercise the scanner against the marker shape rolldown actually produces.
describe("findInlinedExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an external package that was inlined", () => {
    const source =
      region("../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/process.js") +
      region(
        "../../node_modules/.pnpm/msgpackr-extract@3.0.4/node_modules/msgpackr-extract/index.js",
      );
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["detect-libc", "msgpackr-extract"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("flags scoped external packages", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/@ff-labs/fff-node/dist/src/index.js"),
    );
    assert.deepStrictEqual(result.inlined, ["@ff-labs/fff-node"]);
  });

  it("ignores packages that are meant to be bundled", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, []);
    assert.strictEqual(result.regionCount, 2);
  });

  // regionCount is what separates "clean" from "this scan went blind because the
  // marker format changed". A caller that ignores it gets a vacuous pass.
  // The scan has to answer both directions. Checking only that externals are
  // absent still passes on a bundle that externalized everything, which is the
  // failure this whole change prevents.
  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/yaml@2.4.0/node_modules/yaml/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "yaml"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("does not report the pnpm store directory as a package", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js"),
    );
    assert.deepStrictEqual(result.inlinedPackages, ["effect"]);
  });

  it("reports no regions when the marker format is absent", () => {
    const result = findInlinedExternalPackages("var x = 1; // node_modules/detect-libc/lib.js");
    assert.strictEqual(result.regionCount, 0);
    assert.deepStrictEqual(result.inlined, []);
  });
});
