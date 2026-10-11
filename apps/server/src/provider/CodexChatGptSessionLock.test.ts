// @effect-diagnostics nodeBuiltinImport:off - A separate Node process proves filesystem exclusion.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const lockModule = NodeModule.createRequire(import.meta.url).resolve("proper-lockfile");
const instanceId = ProviderInstanceId.make("cross-process-test");
const probe = (directory: string) =>
  Effect.promise(async () => {
    const { stdout } = await execFile(process.execPath, [
      "-e",
      `
    const { lock } = require(process.argv[1]);
    lock(process.argv[2], { realpath: false }).then(async release => {
      await release(); process.stdout.write('acquired');
    }, error => {
      if (error.code === 'ELOCKED') process.stdout.write('blocked');
      else { console.error(error); process.exitCode = 1; }
    });
  `,
      lockModule,
      NodePath.join(directory, "session.bin"),
    ]);
    return stdout;
  });

it.live("excludes another process and releases after the credential update", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const blocked = yield* withChatGptSessionLock(
        directory,
        "session",
        instanceId,
        probe(directory),
      );
      assert.strictEqual(blocked, "blocked");
      assert.strictEqual(yield* probe(directory), "acquired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("releases the cross-process lease when the operation is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const entered = yield* Deferred.make<void>();
      const operation = yield* withChatGptSessionLock(
        directory,
        "session",
        instanceId,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.strictEqual(yield* probe(directory), "blocked");
      yield* Fiber.interrupt(operation);
      assert.strictEqual(yield* probe(directory), "acquired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
