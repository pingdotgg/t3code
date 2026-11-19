// @effect-diagnostics nodeBuiltinImport:off - A separate Node process stands in for another server.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  machineLockFile,
  makeProviderMaintenanceCommandCoordinator,
} from "./providerMaintenanceCommandCoordinator.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const lockModule = NodeModule.createRequire(import.meta.url).resolve("proper-lockfile");
const probe = (file: string) =>
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
      file,
    ]);
    return stdout;
  });

it.live("holds the update's lock key against other server processes while it runs", () =>
  Effect.gen(function* () {
    const lockKey = `test:${NodeCrypto.randomUUID()}`;
    const coordinator = yield* makeProviderMaintenanceCommandCoordinator({
      makeAlreadyRunningError: () => "already running",
    });
    const duringUpdate = yield* coordinator.withCommandLock({
      targetKey: "instance:test",
      lockKey,
      run: probe(machineLockFile(lockKey)),
    });
    assert.strictEqual(duringUpdate, "blocked");
    assert.strictEqual(yield* probe(machineLockFile(lockKey)), "acquired");
  }),
);
