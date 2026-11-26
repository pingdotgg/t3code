import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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

      const read = (requestPath: string, allowedRoots = [workspace]) =>
        readAntigravityClientTextFile({
          fileSystem,
          path,
          allowedRoots,
          attachmentsDir,
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
    }).pipe(Effect.provide(NodeServices.layer)),
);
