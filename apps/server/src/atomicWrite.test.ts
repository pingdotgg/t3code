// @effect-diagnostics nodeBuiltinImport:off - Verify observable Node filesystem contents and permissions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const makeTestDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-test-" });
});

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect("keeps a symlinked file linked and rewrites its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(destination, "before");
      if (!windowsHost) {
        yield* fs.chmod(destination, 0o600);
      }
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
      if (!windowsHost) {
        assert.strictEqual((yield* fs.stat(destination)).mode & 0o777, 0o600);
      }
    }),
  );

  it.effect("keeps a dangling symlink linked and creates its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "fresh" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "fresh");
      if (!windowsHost) {
        assert.strictEqual((yield* fs.stat(destination)).mode & 0o777, 0o600);
      }
    }),
  );

  it.effect("fails on a symlink cycle without replacing either link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const first = path.join(root, "first.json");
      const second = path.join(root, "second.json");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);

      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "after" }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* fs.readLink(first), second);
      assert.strictEqual(yield* fs.readLink(second), first);
    }),
  );

  it.effect("resolves a relative link through a symlinked parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "config", "settings.json");
      const linkedState = path.join(root, "dotfiles", "state");
      const home = path.join(root, "home");
      const link = path.join(home, "state", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(linkedState, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(linkedState, path.join(home, "state"));
      yield* fs.writeFileString(destination, "before");
      if (!windowsHost) {
        yield* fs.chmod(destination, 0o664);
      }
      yield* fs.symlink("../config/settings.json", link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), "../config/settings.json");
      assert.strictEqual(yield* fs.readFileString(destination), "after");
      if (!windowsHost) {
        assert.strictEqual((yield* fs.stat(destination)).mode & 0o777, 0o664);
      }
    }),
  );

  it.effect("creates a missing file and its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "nested", "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: "fresh" });

      assert.strictEqual(yield* fs.readFileString(filePath), "fresh");
      if (!windowsHost) {
        assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, 0o600);
      }
    }),
  );
});

it.effect("surfaces an unreadable link instead of writing over it", () =>
  Effect.gen(function* () {
    const readLinkFailure = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/home/settings.json",
    });

    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }),
    );

    assert.deepStrictEqual(result, Exit.fail(readLinkFailure));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readLink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: "/home/settings.json",
              }),
            ),
          rename: () => Effect.die("an unreadable link must not be replaced"),
        }),
      ),
    ),
  ),
);

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect.each([
    { label: "0600", mode: 0o600 },
    { label: "0644", mode: 0o644 },
    { label: "0664", mode: 0o664 },
  ])("preserves an existing $label file's mode", ({ mode }) =>
    Effect.gen(function* () {
      const dir = yield* makeTestDirectory;
      const filePath = NodePath.join(dir, "settings.json");
      NodeFS.writeFileSync(filePath, "old contents");
      NodeFS.chmodSync(filePath, mode);

      yield* writeFileStringAtomically({ filePath, contents: "new contents" });

      if (!windowsHost) {
        assert.equal(NodeFS.statSync(filePath).mode & 0o777, mode);
      }
      assert.equal(NodeFS.readFileSync(filePath, "utf8"), "new contents");
    }),
  );

  it.effect.each(["settings.json", "nested/parent/settings.json"])(
    "creates missing %s with owner-only permissions",
    (filename) =>
      Effect.gen(function* () {
        const dir = yield* makeTestDirectory;
        const filePath = NodePath.join(dir, filename);

        yield* writeFileStringAtomically({ filePath, contents: "new contents" });

        assert.equal(NodeFS.readFileSync(filePath, "utf8"), "new contents");
        if (!windowsHost) {
          assert.equal(NodeFS.statSync(filePath).mode & 0o777, 0o600);
        }
      }),
  );

  it.effect("preserves the exact UTF-8 bytes, including a trailing newline", () =>
    Effect.gen(function* () {
      const dir = yield* makeTestDirectory;
      const filePath = NodePath.join(dir, "settings.json");
      const contents = "Zażółć gęślą jaźń, 日本語, 🎵\n";

      yield* writeFileStringAtomically({ filePath, contents });

      assert.deepEqual(NodeFS.readFileSync(filePath), Buffer.from(contents, "utf8"));
    }),
  );

  it.effect("removes the temporary directory after a successful write", () =>
    Effect.gen(function* () {
      const dir = yield* makeTestDirectory;
      const filePath = NodePath.join(dir, "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: "new contents" });

      assert.deepEqual(NodeFS.readdirSync(dir), ["settings.json"]);
    }),
  );

  it.effect.skipIf(windowsHost || process.getuid?.() === 0)(
    "leaves the original file intact and no temporary directory when the parent is read-only",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTestDirectory;
        const filePath = NodePath.join(dir, "settings.json");
        NodeFS.writeFileSync(filePath, "old contents");
        NodeFS.chmodSync(filePath, 0o600);
        const parentMode = NodeFS.statSync(dir).mode & 0o777;
        NodeFS.chmodSync(dir, 0o555);

        try {
          const error = yield* writeFileStringAtomically({
            filePath,
            contents: "new contents",
          }).pipe(Effect.flip);

          assert.instanceOf(error, PlatformError.PlatformError);
          assert.equal(NodeFS.readFileSync(filePath, "utf8"), "old contents");
          assert.equal(NodeFS.statSync(filePath).mode & 0o777, 0o600);
          assert.deepEqual(NodeFS.readdirSync(dir), ["settings.json"]);
        } finally {
          NodeFS.chmodSync(dir, parentMode);
        }
      }),
  );
});
