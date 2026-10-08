// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { build } from "vite-plus/pack";

import serverPackage from "../../apps/server/package.json" with { type: "json" };
import {
  isExternalCliDependency,
  selectCliRuntimeExternalDependencies,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";
import { findEsmImportsOfExternalPackages } from "./cli-executable-imports.ts";

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
);

const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

// Copy the installed production JS dependency graph, with no pnpm symlinks back
// into the checkout. Optional platform executables are covered by desktop staging
// tests; this probe never creates a local agent or contacts Cursor.
async function stagePackage(name: string, from: string, destination: string): Promise<void> {
  const require = NodeModule.createRequire(from);
  let source = NodePath.dirname(require.resolve(name));
  while (!NodeFS.existsSync(NodePath.join(source, "package.json"))) {
    const parent = NodePath.dirname(source);
    if (parent === source) throw new Error(`Cannot locate ${name}`);
    source = parent;
  }
  let manifest = decodeManifest(
    await NodeFSP.readFile(NodePath.join(source, "package.json"), "utf8"),
  );
  while (manifest.name !== name) {
    source = NodePath.dirname(source);
    if (source === NodePath.dirname(source)) throw new Error(`Cannot locate ${name}`);
    if (NodeFS.existsSync(NodePath.join(source, "package.json"))) {
      manifest = decodeManifest(
        await NodeFSP.readFile(NodePath.join(source, "package.json"), "utf8"),
      );
    }
  }
  const target = NodePath.join(destination, "node_modules", name);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.cp(source, target, {
    recursive: true,
    filter: (entry) => NodePath.basename(entry) !== "node_modules",
  });
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies };
  for (const dependency of Object.keys(dependencies)) {
    await stagePackage(dependency, NodePath.join(source, "package.json"), target);
  }
}

it("loads packaged Cursor catalog chunks without credentials or checkout dependencies", async () => {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cursor-package-"));
  try {
    // Missing staged dependencies must not resolve from a developer's /tmp tree.
    for (let parent = NodePath.dirname(scratch); ; parent = NodePath.dirname(parent)) {
      assert.isFalse(NodeFS.existsSync(NodePath.join(parent, "node_modules")));
      if (parent === NodePath.dirname(parent)) break;
    }
    const entry = NodePath.join(scratch, "probe.mjs");
    const output = NodePath.join(scratch, "package");
    await NodeFSP.writeFile(
      entry,
      `
      import assert from 'node:assert/strict';
      import { Cursor } from ${JSON.stringify(NodePath.join(repoRoot, "apps/server/src/provider/cursorSdk.ts"))};
      for (const [operation, request] of [
        ['Cursor.models.list', () => Cursor.models.list({ apiKey: '' })],
        ['Cursor.me', () => Cursor.me({ apiKey: '' })],
      ]) {
        await assert.rejects(request, error => {
          assert.equal(error.name, 'ConfigurationError');
          assert.equal(error.operation, operation);
          assert.match(error.message, /empty apiKey explicitly/);
          return true;
        });
      }
      console.log('Cursor catalog chunks loaded; empty keys rejected locally');
    `,
    );
    await build({
      config: false,
      entry: [entry],
      outDir: output,
      platform: "node",
      format: "esm",
      dts: false,
      logLevel: "error",
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: isExternalCliDependency,
        onlyBundle: false,
      },
    });
    const roots = selectCliRuntimeExternalDependencies({
      "@cursor/sdk": serverPackage.dependencies["@cursor/sdk"],
    });
    for (const name of Object.keys(roots)) {
      await stagePackage(name, NodePath.join(repoRoot, "apps/server/package.json"), output);
    }
    const probe = NodePath.join(output, "probe.mjs");
    assert.deepEqual(findEsmImportsOfExternalPackages(await NodeFSP.readFile(probe, "utf8")), []);
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      ["--no-global-search-paths", probe],
      {
        cwd: output,
        env: {
          HOME: scratch,
          USERPROFILE: scratch,
          PATH: "",
          SystemRoot: process.env.SystemRoot ?? "",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.include(stdout, "Cursor catalog chunks loaded; empty keys rejected locally");
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
