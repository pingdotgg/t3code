// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem and SQLite fixtures exercise the cross-process lock protocol.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { expect, it } from "vite-plus/test";

import {
  hasLegacyIndexFiles,
  pinPublishedGeneration,
  removeIndexRoot,
  removeLegacyIndexFromCheckout,
  tryLockBuild,
} from "./codeIndexLocks.ts";
import {
  linkCheckoutSources,
  publishGeneration,
  readPublishedGeneration,
  writeIndexedCheckout,
} from "./codeIndexLayout.ts";

it("removes checkout links while preserving a pinned generation and its source files", () => {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-cleanup-"));
  const checkout = NodePath.join(temporary, "checkout");
  const root = NodePath.join(temporary, "index");
  let pin: ReturnType<typeof pinPublishedGeneration> | undefined;
  try {
    NodeFS.mkdirSync(NodePath.join(checkout, "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(checkout, "src/main.ts"), "export const main = 1;");
    NodeFS.writeFileSync(NodePath.join(checkout, "top.ts"), "export const top = 1;");
    writeIndexedCheckout(root, checkout);
    linkCheckoutSources(root, checkout, ["src/main.ts", "top.ts"]);
    publishGeneration(root, 1);
    const generation = NodePath.join(root, ".codegraph-t3-g1");
    NodeFS.mkdirSync(generation);
    NodeFS.writeFileSync(NodePath.join(generation, "codegraph.db"), "index payload");
    pin = pinPublishedGeneration(root);

    removeIndexRoot(root);

    expect(readPublishedGeneration(root)).toBeNull();
    expect(NodeFS.existsSync(generation)).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "src"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "top.ts"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(checkout, "src/main.ts"), "utf8")).toBe(
      "export const main = 1;",
    );
    expect(NodeFS.readFileSync(NodePath.join(checkout, "top.ts"), "utf8")).toBe(
      "export const top = 1;",
    );

    pin.release();
    pin = undefined;
    removeIndexRoot(root);
    expect(NodeFS.existsSync(root)).toBe(false);
  } finally {
    pin?.release();
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
});

// Windows refuses to delete a file another handle has open, so there the first lock simply stands.
it.each([
  ["deleted", () => null],
  ["deleted and taken by another builder", tryLockBuild],
] as const)("never lets two builders hold a lock %s before it landed", (_name, afterRemoval) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-lock-"));
  const holders: Array<(() => void) | null> = [];
  try {
    holders.push(
      tryLockBuild(root, () => {
        removeIndexRoot(root);
        holders.push(afterRemoval(root));
      }),
    );
    holders.push(tryLockBuild(root));
    expect(holders.filter((holder) => holder !== null)).toHaveLength(1);
  } finally {
    for (const holder of holders) holder?.();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const legacyCheckout = (files: ReadonlyArray<string>) => {
  const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-legacy-"));
  NodeFS.writeFileSync(NodePath.join(checkout, "keep.txt"), "mine");
  for (const file of files) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(checkout, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(checkout, file), "");
  }
  return checkout;
};

it.each([
  [
    "a published index",
    [
      ".codegraph-t3/.gitignore",
      ".codegraph-t3/published",
      ".codegraph-t3/build.lock",
      ".codegraph-t3/building.lock",
      ".codegraph-t3-g3/.gitignore",
      ".codegraph-t3-g3/codegraph.db",
      ".codegraph-t3-g3/codegraph.db-shm",
      ".codegraph-t3-g3/codegraph.db-wal",
      ".codegraph-t3-g3/readers.lock",
      ".codegraph-t3-g3/t3-index.json",
    ],
  ],
  ["only lock files", [".codegraph-t3/.gitignore", ".codegraph-t3/build.lock"]],
  ["a generation with no control folder", [".codegraph-t3-g3/codegraph.db"]],
])("leaves nothing of T3's in a checkout holding %s", (_name, files) => {
  const checkout = legacyCheckout(files);
  try {
    expect(hasLegacyIndexFiles(checkout)).toBe(true);
    removeLegacyIndexFromCheckout(checkout);
    expect(NodeFS.readdirSync(checkout)).toEqual(["keep.txt"]);
    expect(hasLegacyIndexFiles(checkout)).toBe(false);
  } finally {
    NodeFS.rmSync(checkout, { recursive: true, force: true });
  }
});

it("keeps the user's files in an older version's control folder", () => {
  const checkout = legacyCheckout([
    ".codegraph-t3/.gitignore",
    ".codegraph-t3/published",
    ".codegraph-t3/build.lock",
    ".codegraph-t3/notes.txt",
    ".codegraph-t3/mine/a.txt",
    ".codegraph-t3-g3/codegraph.db",
    ".codegraph-t3-g3/notes.txt",
  ]);
  try {
    removeLegacyIndexFromCheckout(checkout);
    expect(
      NodeFS.readdirSync(NodePath.join(checkout, ".codegraph-t3"), { recursive: true }).toSorted(),
    ).toEqual(["mine", NodePath.join("mine", "a.txt"), "notes.txt"]);
    expect(NodeFS.readdirSync(NodePath.join(checkout, ".codegraph-t3-g3")).toSorted()).toEqual([
      "codegraph.db",
      "notes.txt",
    ]);
    expect(hasLegacyIndexFiles(checkout)).toBe(false);
  } finally {
    NodeFS.rmSync(checkout, { recursive: true, force: true });
  }
});

it.skipIf(!symlinksSupported).each([
  [".codegraph-t3", "build.lock", "published"],
  [".codegraph-t3-g1", "readers.lock", "codegraph.db"],
])("leaves linked locks inside a legacy %s untouched", (directory, lock, marker) => {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-link-"));
  const checkout = NodePath.join(temporary, "checkout");
  const target = NodePath.join(temporary, "outside.sqlite");
  const legacy = NodePath.join(checkout, directory);
  try {
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, marker), "untouched");
    NodeFS.symlinkSync(target, NodePath.join(legacy, lock), "file");

    removeLegacyIndexFromCheckout(checkout);

    expect(NodeFS.existsSync(target)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(legacy, marker), "utf8")).toBe("untouched");
    expect(NodeFS.lstatSync(NodePath.join(legacy, lock)).isSymbolicLink()).toBe(true);
    expect(hasLegacyIndexFiles(checkout)).toBe(false);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
});
