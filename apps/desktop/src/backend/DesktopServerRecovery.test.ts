// @effect-diagnostics nodeBuiltinImport:off - The suite runs real child processes to prove the
// recovery stops a stranded server and leaves everything else alone. The fixtures are isolated
// temporary scripts; no desktop session or user state is touched.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DesktopServerOwnership from "./DesktopServerOwnership.ts";
import { recoverStrandedServer } from "./DesktopServerRecovery.ts";

const FIXTURE_PRELUDE = [
  'import * as NodeFS from "node:fs";',
  "const log = (m) => NodeFS.appendFileSync(process.env.FIXTURE_LOG, m + String.fromCharCode(10));",
  "const announce = (m) => process.stdout.write(m + String.fromCharCode(10));",
];

const IGNORE_SIGTERM_SOURCE = [
  ...FIXTURE_PRELUDE,
  'process.on("SIGTERM", () => log("sigterm"));',
  'process.on("SIGINT", () => log("sigint"));',
  // The announcement comes after the handlers are installed, so a test that
  // saw it knows the server can act on a signal.
  'announce("ready pid=" + process.pid);',
  'log("ready pid=" + process.pid);',
  "setInterval(() => {}, 200);",
  "",
].join("\n");

const COOPERATIVE_SOURCE = [
  ...FIXTURE_PRELUDE,
  "const timer = setInterval(() => {}, 200);",
  'process.on("SIGTERM", () => { log("sigterm"); clearInterval(timer); });',
  'announce("ready pid=" + process.pid);',
  'log("ready pid=" + process.pid);',
  "",
].join("\n");

/**
 * A server that has not announced itself yet.
 */
class FixtureNotReadyError extends Schema.TaggedError<FixtureNotReadyError>()(
  "FixtureNotReadyError",
  {},
) {
  override get message(): string {
    return "The server fixture did not start in time.";
  }
}

const FIXTURE_STARTUP_TIMEOUT = Duration.seconds(30);

interface Fixture {
  readonly log: string;
  readonly pid: number;
  /** Completes when the fixture announces itself on stdout. */
  readonly ready: Effect.Effect<void, FixtureNotReadyError>;
}

const spawnFixture = (source: string): Fixture => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-fixture-"));
  const script = NodePath.join(dir, "backend.mjs");
  const log = NodePath.join(dir, "fixture.log");
  NodeFS.writeFileSync(script, source);
  const child = NodeChildProcess.spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, FIXTURE_LOG: log },
    detached: true,
  });
  const ready = Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        // The fixture writes its announcement to stdout, which the parent
        // reads. Nothing else resolves the wait, so a fixture that never
        // starts is a timeout, not a hang.
        let buffered = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          if (buffered.includes("ready pid=")) {
            resolve();
          }
        });
      }),
  ).pipe(
    Effect.timeoutOption(FIXTURE_STARTUP_TIMEOUT),
    Effect.flatMap((result) =>
      Option.isSome(result) ? Effect.void : Effect.fail(new FixtureNotReadyError()),
    ),
  );
  return { log, pid: child.pid ?? -1, ready };
};

const readFixtureLog = (logPath: string): string =>
  NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8") : "";

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const strandedOwner = (
  pid: number,
): Extract<DesktopServerOwnership.DesktopServerOwner, { readonly _tag: "stranded" }> => ({
  _tag: "stranded",
  record: {
    version: 1,
    pid,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    startedAt: "1970-01-01T00:00:00.000Z",
  },
});

describe("DesktopServerRecovery", () => {
  it.live("stops a stranded server that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture(IGNORE_SIGTERM_SOURCE);
      yield* fixture.ready;
      assert.isTrue(isProcessAlive(fixture.pid), "the fixture must be running");

      const recovered = yield* recoverStrandedServer({ owner: strandedOwner(fixture.pid) });

      assert.isTrue(recovered, "the recovery must report that the server was stopped");
      assert.isFalse(isProcessAlive(fixture.pid), "the stranded server must be gone");
      assert.include(
        readFixtureLog(fixture.log),
        "sigterm",
        "the recovery must try the graceful signal first",
      );
    }),
  );

  it.live("stops a stranded server that shuts down cleanly", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture(COOPERATIVE_SOURCE);
      yield* fixture.ready;
      assert.isTrue(isProcessAlive(fixture.pid), "the fixture must be running");

      const recovered = yield* recoverStrandedServer({ owner: strandedOwner(fixture.pid) });

      assert.isTrue(recovered, "the recovery must report that the server was stopped");
      assert.isFalse(isProcessAlive(fixture.pid), "the stranded server must be gone");
    }),
  );
});
