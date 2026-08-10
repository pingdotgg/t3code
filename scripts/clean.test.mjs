import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test from "node:test";

import { cleanRepository, collectCleanTargets } from "./clean.mjs";

function makeDirectory(root, relativePath) {
  const directory = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "fixture.txt"), "fixture\n");
  return directory;
}

test(
  "cleanRepository removes the original generated-directory contract under spaces and Unicode",
  () => {
    const outer = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 clean "));
    const root = NodePath.join(outer, "T3 Code José QA");
    NodeFS.mkdirSync(root, { recursive: true });

    const expected = [
      makeDirectory(root, "node_modules"),
      makeDirectory(root, ".vite-plus"),
      makeDirectory(root, "apps/web/node_modules"),
      makeDirectory(root, "apps/web/.vite-plus"),
      makeDirectory(root, "apps/web/dist"),
      makeDirectory(root, "apps/web/dist-electron"),
      makeDirectory(root, "packages/shared/node_modules"),
      makeDirectory(root, "packages/shared/.vite-plus"),
      makeDirectory(root, "packages/shared/dist"),
    ];
    const preserved = makeDirectory(root, "apps/web/src");

    try {
      const targets = collectCleanTargets(root);
      for (const target of expected) assert.ok(targets.includes(target), target);

      cleanRepository(root);
      for (const target of expected) assert.equal(NodeFS.existsSync(target), false, target);
      assert.equal(NodeFS.existsSync(preserved), true);
    } finally {
      NodeFS.rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
