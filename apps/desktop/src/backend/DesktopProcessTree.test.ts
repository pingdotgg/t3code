// @effect-diagnostics nodeBuiltinImport:off - The suite runs a real child process to prove the
// process-tree helpers. The fixture is an isolated temporary script; no desktop session or user
// state is touched.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";

import * as DesktopProcessTree from "./DesktopProcessTree.ts";

const FIXTURE_SOURCE = `
process.stdout.write("ready pid=" + process.pid + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 200);
`;

interface Fixture {
  readonly pid: number;
  /** Completes when the fixture has announced itself. */
  readonly ready: Effect.Effect<void>;
  /** Completes when the fixture has exited. */
  readonly exited: Effect.Effect<void>;
}

const spawnFixture = (): Fixture => {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", FIXTURE_SOURCE], {
    stdio: ["ignore", "pipe", "ignore"],
    // The fixture leads its own process group, like a backend the desktop
    // starts detached.
    detached: true,
  });
  const ready = Effect.callback<void>((resume) => {
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (buffered.includes("ready pid=")) {
        resume(Effect.void);
      }
    });
  });
  const exited = Effect.callback<void>((resume) => {
    child.once("exit", () => {
      resume(Effect.void);
    });
  });
  return { pid: child.pid ?? -1, ready, exited };
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

describe("DesktopProcessTree", () => {
  it.live("reports a running backend as alive and a gone one as gone", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture();
      yield* fixture.ready;
      assert.isTrue(isProcessAlive(fixture.pid), "the fixture must be running");
      assert.isTrue(
        yield* DesktopProcessTree.isProcessTreeAlive(fixture.pid),
        "a running backend must be reported as alive",
      );

      yield* DesktopProcessTree.signalProcessTree(fixture.pid, "SIGTERM");
      yield* fixture.exited;

      assert.isFalse(
        yield* DesktopProcessTree.isProcessTreeAlive(fixture.pid),
        "a backend that exited must be reported as gone",
      );
    }),
  );

  it.live("signals the process group, not only the leader", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture();
      yield* fixture.ready;

      assert.isTrue(
        yield* DesktopProcessTree.signalProcessTree(fixture.pid, "SIGTERM"),
        "the tree must be signalled",
      );
      yield* fixture.exited;
      assert.isFalse(isProcessAlive(fixture.pid));
    }),
  );

  it.effect("refuses to signal a group id that would reach every process", () =>
    Effect.gen(function* () {
      // Signalling -1 reaches every process the user can signal, and 0
      // reaches the caller's own group. Neither is a backend the desktop
      // started.
      assert.isFalse(
        yield* DesktopProcessTree.signalProcessTree(1, "SIGKILL"),
        "group id 1 must never be signalled",
      );
      assert.isFalse(
        yield* DesktopProcessTree.signalProcessTree(0, "SIGKILL"),
        "group id 0 must never be signalled",
      );
    }),
  );

  it.live("waits for a tree that is gone and gives up on one that is alive", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture();
      yield* fixture.ready;

      const alive = yield* DesktopProcessTree.waitForProcessTreeExit(
        fixture.pid,
        Duration.millis(200),
        Duration.millis(50),
      );
      assert.isFalse(alive, "a live tree must not be reported as gone");

      yield* DesktopProcessTree.signalProcessTree(fixture.pid, "SIGTERM");
      yield* fixture.exited;

      const gone = yield* DesktopProcessTree.waitForProcessTreeExit(
        fixture.pid,
        Duration.seconds(5),
        Duration.millis(50),
      );
      assert.isTrue(gone, "a tree with no members must be reported as gone");
    }),
  );
});
