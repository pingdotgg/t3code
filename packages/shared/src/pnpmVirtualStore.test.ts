// @effect-diagnostics nodeBuiltinImport:off - fixtures for build-tool filesystem visibility.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, test } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  pnpmViteFsAllow,
  pnpmVirtualStoreFolders,
  pnpmMetroWatchFolders,
} from "@t3tools/shared/pnpmVirtualStore";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

test.skipIf(!symlinksSupported)(
  "Vite can serve symlink targets in an external pnpm virtual store",
  () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "metro-pnpm-")),
    );
    roots.push(root);
    const workspace = NodePath.join(root, "worktree");
    const modules = NodePath.join(workspace, "node_modules");
    const store = NodePath.join(root, "custom-store", "links");
    const react = NodePath.join(store, "react", "node_modules", "react");
    NodeFS.mkdirSync(react, { recursive: true });
    NodeFS.mkdirSync(modules, { recursive: true });
    NodeFS.symlinkSync(react, NodePath.join(modules, "react"), "dir");
    const target = NodeFS.realpathSync(NodePath.join(modules, "react"));
    for (const virtualStoreDir of [NodePath.relative(modules, store), store]) {
      NodeFS.writeFileSync(
        NodePath.join(modules, ".modules.yaml"),
        JSON.stringify({ virtualStoreDir }),
      );
      NodeAssert.equal(pnpmVirtualStoreFolders(workspace).length, 1);
      NodeAssert.deepEqual(pnpmViteFsAllow(NodePath.join(workspace, "apps", "web")), [
        workspace,
        store,
      ]);
      NodeAssert.ok(target.startsWith(pnpmVirtualStoreFolders(workspace)[0] + NodePath.sep));
    }
    NodeFS.writeFileSync(
      NodePath.join(modules, ".modules.yaml"),
      JSON.stringify({ virtualStoreDir: ".pnpm" }),
    );
    NodeAssert.deepEqual(pnpmVirtualStoreFolders(workspace), []);
    NodeAssert.deepEqual(pnpmViteFsAllow(NodePath.join(workspace, "apps", "web")), [workspace]);
  },
);

test.skipIf(!symlinksSupported)(
  "Metro watches only reachable store slots, including transitive links",
  () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "metro-slots-")),
    );
    roots.push(root);
    const workspace = NodePath.join(root, "worktree");
    const store = NodePath.join(root, "store/links");
    const slotA = NodePath.join(store, "direct/1/hash-a");
    const slotB = NodePath.join(store, "transitive/1/hash-b");
    const slotUnused = NodePath.join(store, "unused/1/hash-c");
    const slotWorkspace = NodePath.join(store, "workspace-peer/1/hash-d");
    const modules = NodePath.join(workspace, "apps/mobile/node_modules");
    for (const slot of [slotA, slotB, slotUnused, slotWorkspace]) {
      NodeFS.mkdirSync(NodePath.join(slot, "node_modules/pkg"), { recursive: true });
    }
    NodeFS.mkdirSync(modules, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(workspace, "node_modules"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(workspace, "node_modules/.modules.yaml"),
      JSON.stringify({ virtualStoreDir: store }),
    );
    NodeFS.symlinkSync(
      NodePath.join(slotA, "node_modules/pkg"),
      NodePath.join(modules, "direct"),
      "dir",
    );
    NodeFS.symlinkSync(
      NodePath.join(slotB, "node_modules/pkg"),
      NodePath.join(slotA, "node_modules/transitive"),
      "dir",
    );
    NodeFS.symlinkSync(
      NodePath.join(slotA, "node_modules/pkg"),
      NodePath.join(slotB, "node_modules/cycle"),
      "dir",
    );
    const shared = NodePath.join(workspace, "packages/shared");
    NodeFS.mkdirSync(NodePath.join(shared, "node_modules"), { recursive: true });
    NodeFS.symlinkSync(shared, NodePath.join(modules, "shared"), "dir");
    NodeFS.symlinkSync(
      NodePath.join(slotWorkspace, "node_modules/pkg"),
      NodePath.join(shared, "node_modules/pkg"),
      "dir",
    );
    NodeAssert.deepEqual(
      pnpmMetroWatchFolders(workspace).sort(),
      [slotA, slotB, slotWorkspace].sort(),
    );
  },
);

test("missing or legacy modules metadata keeps local-store configs usable", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pnpm-metadata-"));
  roots.push(root);
  NodeAssert.deepEqual(pnpmVirtualStoreFolders(root), []);
  NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
  NodeFS.writeFileSync(
    NodePath.join(root, "node_modules/.modules.yaml"),
    "virtualStoreDir: .pnpm\n",
  );
  NodeAssert.deepEqual(pnpmVirtualStoreFolders(root), []);
});
