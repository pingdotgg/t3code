import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { readAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

it.effect(
  "confines attachment reads to allowed attachments and blocks ancestor-workspace bypasses",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const workspace = path.join(base, "workspace");
      const attachmentsDir = path.join(base, "attachments");
      yield* fileSystem.makeDirectory(workspace);
      yield* fileSystem.makeDirectory(attachmentsDir);
      const owned = path.join(attachmentsDir, "owned.txt");
      const unowned = path.join(attachmentsDir, "unowned.txt");
      yield* fileSystem.writeFileString(owned, "attachment");
      yield* fileSystem.writeFileString(unowned, "secret");
      yield* fileSystem.writeFileString(path.join(workspace, "..notes"), "notes");

      const read = (
        requestPath: string,
        allowedRoots = [workspace],
        overrides?: {
          readonly fileSystem?: FileSystem.FileSystem;
          readonly attachmentsDir?: string;
        },
      ) =>
        readAntigravityClientTextFile({
          fileSystem: overrides?.fileSystem ?? fileSystem,
          path,
          allowedRoots,
          attachmentsDir: overrides?.attachmentsDir ?? attachmentsDir,
          isAllowedAttachment: (file) => Effect.succeed(file === owned),
          request: { sessionId: "session", path: requestPath },
        });

      assert.equal((yield* read(owned)).content, "attachment");
      assert.propertyVal(yield* read(unowned).pipe(Effect.flip), "code", -32602);
      assert.propertyVal(yield* read(unowned, [base]).pipe(Effect.flip), "code", -32602);
      assert.equal((yield* read(owned, [base])).content, "attachment");
      assert.equal((yield* read(path.join(workspace, "..notes"))).content, "notes");

      const outside = path.join(base, "outside.txt");
      yield* fileSystem.writeFileString(outside, "outside");
      const link = path.join(workspace, "escape");
      yield* fileSystem.symlink(outside, link);
      assert.propertyVal(yield* read(link).pipe(Effect.flip), "code", -32602);

      // Symlink-first resolution: `link/../file.txt` follows `link` before applying `..`.
      const dirA = path.join(workspace, "dir-a");
      const dirB = path.join(workspace, "dir-b");
      const dirBSub = path.join(dirB, "sub");
      yield* fileSystem.makeDirectory(dirA);
      yield* fileSystem.makeDirectory(dirBSub, { recursive: true });
      yield* fileSystem.writeFileString(path.join(dirA, "file.txt"), "from-dir-a");
      yield* fileSystem.writeFileString(path.join(dirB, "file.txt"), "from-dir-b");
      yield* fileSystem.symlink(dirBSub, path.join(dirA, "link"));
      assert.equal(
        (yield* read(`${path.join(dirA, "link")}${path.sep}..${path.sep}file.txt`)).content,
        "from-dir-b",
      );

      const outsideSub = path.join(base, "outside-sub");
      yield* fileSystem.makeDirectory(outsideSub);
      yield* fileSystem.symlink(outsideSub, path.join(dirA, "escape-dir"));
      assert.propertyVal(
        yield* read(`${path.join(dirA, "escape-dir")}${path.sep}..${path.sep}outside.txt`).pipe(
          Effect.flip,
        ),
        "code",
        -32602,
      );
      assert.propertyVal(
        yield* read(`${path.join(dirA, "missing")}${path.sep}..${path.sep}file.txt`).pipe(
          Effect.flip,
        ),
        "code",
        -32602,
      );

      // Fail closed if resolving a symlinked attachmentsDir fails even under an ancestor workspace.
      const attachmentsLink = path.join(base, "attachments-link");
      yield* fileSystem.symlink(attachmentsDir, attachmentsLink);
      const failingFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        realPath: (target) =>
          target === attachmentsLink
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "realPath",
                  pathOrDescriptor: target,
                  description: "injected attachmentsDir lookup failure",
                }),
              )
            : fileSystem.realPath(target),
      };
      assert.propertyVal(
        yield* read(unowned, [base], {
          fileSystem: failingFileSystem,
          attachmentsDir: attachmentsLink,
        }).pipe(Effect.flip),
        "code",
        -32602,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
