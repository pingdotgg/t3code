// @effect-diagnostics nodeBuiltinImport:off - Fixtures write trees and read raw stat data.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { makeReflinkCloner } from "./reflinkCloner.ts";

const reflinkDir = process.env.T3_REFLINK_TEST_DIR;
const isLinux = HostProcess.Platform.defaultValue() === "linux";

const tempTree = (parent: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(parent, "t3-reflink-cloner-"));
      const source = NodePath.join(root, "source");
      NodeFS.mkdirSync(NodePath.join(source, "nested", "deeper"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(source, "nested", "deeper", "data.txt"),
        "x".repeat(70_000),
      );
      NodeFS.writeFileSync(NodePath.join(source, "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
      NodeFS.symlinkSync(
        NodePath.join("nested", "deeper", "data.txt"),
        NodePath.join(source, "link"),
      );
      return { root, source, destination: NodePath.join(root, "destination") };
    }),
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const clone = (source: string, destination: string) =>
  makeReflinkCloner.pipe(Effect.flatMap((cloner) => cloner(source, destination)));

describe.skipIf(!isLinux)("reflink cloner", () => {
  it.live("fails without leaving a destination on a drive that cannot reflink", () =>
    Effect.gen(function* () {
      const tree = yield* tempTree("/dev/shm");
      const error = yield* clone(tree.source, tree.destination).pipe(Effect.flip);
      assert.equal(error._tag, "CheckoutCloneError");
      assert.isFalse(NodeFS.existsSync(tree.destination));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["folder", "dangling symlink"])("refuses an existing %s", (kind) =>
    Effect.gen(function* () {
      const tree = yield* tempTree(NodeOS.tmpdir());
      if (kind === "folder") NodeFS.mkdirSync(tree.destination);
      else NodeFS.symlinkSync("missing", tree.destination);
      const error = yield* clone(tree.source, tree.destination).pipe(Effect.flip);
      assert.equal(error._tag, "CheckoutCloneError");
      assert.isTrue(NodeFS.lstatSync(tree.destination).isSymbolicLink() === (kind !== "folder"));
      assert.deepEqual(kind === "folder" ? NodeFS.readdirSync(tree.destination) : [], []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(reflinkDir === undefined)(
    "clones a tree that keeps what the checkout cache checks",
    () =>
      Effect.gen(function* () {
        const tree = yield* tempTree(reflinkDir!);
        yield* clone(tree.source, tree.destination);
        for (const entry of [
          "",
          "nested",
          NodePath.join("nested", "deeper"),
          NodePath.join("nested", "deeper", "data.txt"),
          "tool.sh",
          "link",
        ]) {
          const original = NodeFS.lstatSync(NodePath.join(tree.source, entry), { bigint: true });
          const cloned = NodeFS.lstatSync(NodePath.join(tree.destination, entry), {
            bigint: true,
          });
          assert.equal(cloned.mode, original.mode, entry);
          assert.equal(cloned.mtimeNs, original.mtimeNs, entry);
          assert.notEqual(cloned.ino, original.ino, entry);
          if (!original.isDirectory()) assert.equal(cloned.size, original.size, entry);
        }
        assert.equal(
          NodeFS.readlinkSync(NodePath.join(tree.destination, "link")),
          NodePath.join("nested", "deeper", "data.txt"),
        );
        assert.equal(
          NodeFS.statSync(NodePath.join(tree.destination, "tool.sh")).mode & 0o111,
          0o111,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
