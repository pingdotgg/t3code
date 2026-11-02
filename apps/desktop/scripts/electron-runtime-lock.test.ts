// @effect-diagnostics nodeBuiltinImport:off - subprocess fixtures drive the shared-runtime filesystem lock.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withPublishLock } from "./electron-runtime-lock.mjs";

const CONTENDER = `
import * as fs from 'node:fs';
import { withPublishLock } from ${JSON.stringify(new URL("./electron-runtime-lock.mjs", import.meta.url).href)};
const [dir, stale] = process.argv.slice(1);
const probe = process.kill;
let observedStale = false;
let observedLive = false;
const milestone = value => fs.writeSync(1, value + '\\n');
const gate = () => fs.readSync(0, Buffer.alloc(1), 0, 1, null);
process.kill = (pid, signal) => {
  if (signal === 0 && pid === Number(stale) && !observedStale) {
    observedStale = true;
    milestone('stale');
    gate();
  } else if (signal === 0 && pid !== Number(stale) && !observedLive) {
    observedLive = true;
    milestone('live');
    gate();
  }
  return probe(pid, signal);
};
withPublishLock(dir, () => {
  milestone('entered');
  gate();
});
`;

const RELEASE = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { withPublishLock } from ${JSON.stringify(new URL("./electron-runtime-lock.mjs", import.meta.url).href)};
const [directory, code, failures, expectedAttempts] = process.argv.slice(1);
const unlink = fs.unlinkSync;
const fault = Object.assign(new Error('claim is busy'), { code });
let attempts = 0;
fs.unlinkSync = target => {
  if (path.basename(target).startsWith('owner-') && ++attempts <= Number(failures)) throw fault;
  return unlink(target);
};
syncBuiltinESMExports();
let thrown;
try {
  assert.equal(withPublishLock(directory, () => 'published'), 'published');
} catch (error) {
  thrown = error;
}
assert.equal(thrown, Number(failures) >= Number(expectedAttempts) ? fault : undefined);
assert.equal(attempts, Number(expectedAttempts));
if (!thrown) assert.deepEqual(fs.readdirSync(directory), []);
`;

const contender = Effect.fn("test.electronLockContender")((directory: string, stalePid: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "--eval", CONTENDER, directory, String(stalePid)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const stale = Promise.withResolvers<void>();
      const live = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let output = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        for (;;) {
          const end = output.indexOf("\n");
          if (end === -1) break;
          const value = output.slice(0, end);
          output = output.slice(end + 1);
          if (value === "stale") stale.resolve();
          if (value === "live") live.resolve();
          if (value === "entered") entered.resolve();
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      const milestones = { stale, live, entered };
      const waitFor = (name: keyof typeof milestones) =>
        Promise.race([
          milestones[name].promise,
          closed.then((code) => {
            throw new Error(`Lock contender exited ${String(code)}: ${stderr}`);
          }),
        ]);
      return { child, waitFor, closed };
    }),
    ({ child, closed }) =>
      Effect.promise(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await closed;
      }),
  ),
);

it.live("does not evict a fresh publisher after observing an old dead lock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-lock-"))),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const dead = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]);
      NodeAssert.equal(dead.status, 0);
      const lock = NodePath.join(directory, ".t3-publish.lock");
      NodeFS.mkdirSync(lock);
      NodeFS.writeFileSync(NodePath.join(lock, "pid"), String(dead.pid));
      const first = yield* contender(directory, dead.pid);
      const second = yield* contender(directory, dead.pid);
      yield* Effect.promise(() => Promise.all([first.waitFor("stale"), second.waitFor("stale")]));
      first.child.stdin.write("1");
      yield* Effect.promise(() => first.waitFor("entered"));
      second.child.stdin.write("1");
      const next = yield* Effect.promise(() =>
        Promise.race([
          second.waitFor("live").then(() => "live"),
          second.waitFor("entered").then(() => "entered"),
        ]),
      );
      NodeAssert.equal(next, "live");
      first.child.stdin.write("1");
      NodeAssert.equal(yield* Effect.promise(() => first.closed), 0);
      second.child.stdin.write("1");
      yield* Effect.promise(() => second.waitFor("entered"));
      second.child.stdin.write("1");
      NodeAssert.equal(yield* Effect.promise(() => second.closed), 0);
      NodeAssert.deepEqual(NodeFS.readdirSync(directory), []);
      NodeFS.mkdirSync(lock);
      const published = NodePath.join(directory, "published");
      withPublishLock(directory, () => NodeFS.writeFileSync(published, "ready"));
      NodeAssert.equal(NodeFS.readFileSync(published, "utf8"), "ready");
      NodeAssert.deepEqual(NodeFS.readdirSync(directory), ["published"]);
    }),
  ),
);

it.live("retries transient claim removal errors and propagates persistent failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-lock-"))),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      for (const [code, failures, attempts] of [
        ["EPERM", 2, 3],
        ["EBUSY", 2, 3],
        ["EPERM", 100, 4],
        ["EBUSY", 100, 4],
        ["EACCES", 100, 1],
      ]) {
        const root = NodeFS.mkdtempSync(NodePath.join(directory, "case-"));
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            RELEASE,
            root,
            String(code),
            String(failures),
            String(attempts),
          ],
          { encoding: "utf8" },
        );
        NodeAssert.equal(result.status, 0, result.stderr);
      }
    }),
  ),
);
