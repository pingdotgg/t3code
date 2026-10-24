// @effect-diagnostics nodeBuiltinImport:off - The suite runs real child processes to prove the
// stop escalation ends the backend and its process group. The fixtures are isolated temporary
// scripts; no desktop session or user state is touched.
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

/**
 * The fixtures announce themselves on stdout and record every event in a
 * file. The announcement is the milestone the test waits for, and the file
 * keeps the record of a signal the manager's output drain may not deliver,
 * because the drain is interrupted by the same scope close that stops the
 * backend.
 */
const FIXTURE_PRELUDE = [
  'import * as NodeFS from "node:fs";',
  "const log = (m) => NodeFS.appendFileSync(process.env.FIXTURE_LOG, m + String.fromCharCode(10));",
  "const announce = (m) => process.stdout.write(m + String.fromCharCode(10));",
];

/**
 * A backend that ignores SIGTERM, like one wedged in a long provider call.
 * The desktop's stop must escalate to SIGKILL, or the backend survives the
 * quit and keeps holding the T3 home's ownership lock.
 */
const STUBBORN_BACKEND_SOURCE = [
  ...FIXTURE_PRELUDE,
  'process.on("SIGTERM", () => log("sigterm"));',
  'process.on("SIGINT", () => log("sigint"));',
  // The announcement comes after the handlers are installed, so a test that
  // saw it knows the backend can act on a signal.
  'log("ready pid=" + process.pid);',
  'announce("ready pid=" + process.pid);',
  "setInterval(() => {}, 200);",
  "",
].join("\n");

/**
 * A backend that spawns a child and ignores SIGTERM. The stop must take the
 * whole process group down, or the child outlives the quit.
 */
const CHILD_BACKEND_SOURCE = [
  ...FIXTURE_PRELUDE,
  'import { spawn } from "node:child_process";',
  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'process.on("SIGTERM", () => log("sigterm"));',
  'process.on("SIGINT", () => log("sigint"));',
  'log("ready pid=" + process.pid + " child pid=" + child.pid);',
  'announce("ready pid=" + process.pid);',
  "setInterval(() => {}, 200);",
  "",
].join("\n");

/**
 * A backend that shuts down cleanly on SIGTERM, like a real one does.
 */
const COOPERATIVE_BACKEND_SOURCE = [
  ...FIXTURE_PRELUDE,
  // The timer is cleared instead of calling process.exit, so the process ends
  // on its own and the file write is not cut short.
  "const timer = setInterval(() => {}, 200);",
  'process.on("SIGTERM", () => { log("sigterm"); clearInterval(timer); });',
  'log("ready pid=" + process.pid);',
  'announce("ready pid=" + process.pid);',
  "",
].join("\n");

/**
 * A backend that has not announced itself yet.
 */
class FixtureNotReadyError extends Schema.TaggedError<FixtureNotReadyError>()(
  "FixtureNotReadyError",
  {},
) {
  override get message(): string {
    return "The backend fixture did not start in time.";
  }
}

const FIXTURE_STARTUP_TIMEOUT = Duration.seconds(30);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readFixtureLog = (logPath: string): string =>
  NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8") : "";

const pidFromLog = (log: string, label: string): number => {
  const match = new RegExp(`${label} pid=(\\d+)`).exec(log);
  return match === null ? -1 : Number.parseInt(match[1] ?? "", 10);
};

/**
 * Wait for the fixture to announce itself on stdout. The announcement is the
 * milestone, so the test never sleeps on a guess, and a fixture that never
 * starts fails the test instead of looking like a stopped one.
 */
const awaitFixtureReady = (
  ready: Deferred.Deferred<void>,
): Effect.Effect<void, FixtureNotReadyError> =>
  Deferred.await(ready).pipe(
    Effect.timeoutOption(FIXTURE_STARTUP_TIMEOUT),
    Effect.flatMap((result) =>
      Option.isSome(result) ? Effect.void : Effect.fail(new FixtureNotReadyError()),
    ),
  );

/** Wait for the manager to record the spawned backend's pid. */
const awaitBackendPid = (
  instance: DesktopBackendManager.DesktopBackendInstance,
): Effect.Effect<number, FixtureNotReadyError> =>
  instance.snapshot.pipe(
    Effect.map((snapshot) => snapshot.activePid),
    Effect.flatMap((pid) =>
      Option.isSome(pid) ? Effect.succeed(pid.value) : Effect.fail(new FixtureNotReadyError()),
    ),
    Effect.retry({ while: () => true }),
    Effect.timeoutOption(FIXTURE_STARTUP_TIMEOUT),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(new FixtureNotReadyError()),
    ),
  );

interface Fixture {
  readonly script: string;
  readonly log: string;
  /** Completes when the fixture announces itself on stdout. */
  readonly ready: Deferred.Deferred<void>;
}

const writeBackendScript = (source: string): Effect.Effect<Fixture> =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-backend-fixture-"));
    const script = NodePath.join(dir, "backend.mjs");
    const log = NodePath.join(dir, "fixture.log");
    NodeFS.writeFileSync(script, source);
    return { script, log, ready: yield* Deferred.make<void>() };
  });

const makeTestInstance = (
  fixture: Fixture,
): Effect.Effect<DesktopBackendManager.DesktopBackendInstance, never, Scope.Scope> =>
  DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Local environment"),
    configResolve: Effect.succeed({
      executablePath: process.execPath,
      args: [fixture.script],
      entryPath: fixture.script,
      cwd: NodePath.dirname(fixture.script),
      env: { FIXTURE_LOG: fixture.log },
      extendEnv: true,
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: 3773,
        t3Home: "/tmp/t3",
        host: "127.0.0.1",
        desktopBootstrapToken: "token",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      bootstrapDelivery: "fd3",
      httpBaseUrl: new URL("http://127.0.0.1:3773"),
      captureOutput: true,
      preflightFailure: Option.none(),
    }),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
            ),
          ),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              // The fixture announces itself on stdout, so its output is the
              // test's milestone.
              writeOutputChunk: (_streamName, chunk) =>
                new TextDecoder().decode(chunk).includes("ready pid=")
                  ? Deferred.succeed(fixture.ready, undefined).pipe(Effect.ignore)
                  : Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            }),
        }),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        DesktopBrowserHost.layer,
        DesktopWslEnvironment.layerTest({}),
      ),
    ),
  );

describe("DesktopBackendManager stop budget", () => {
  it.live("escalates a backend that ignores SIGTERM to SIGKILL", () =>
    Effect.gen(function* () {
      const fixture = yield* writeBackendScript(STUBBORN_BACKEND_SOURCE);
      const instance = yield* makeTestInstance(fixture);

      yield* instance.start;
      const pid = yield* awaitBackendPid(instance);
      yield* awaitFixtureReady(fixture.ready);
      assert.isTrue(isProcessAlive(pid), "the backend must be running before the stop");

      yield* instance.stop({ timeout: DesktopBackendManager.DEFAULT_BACKEND_STOP_TIMEOUT });

      assert.isFalse(
        isProcessAlive(pid),
        "a backend that ignores SIGTERM must still be killed by the stop",
      );
      assert.include(
        readFixtureLog(fixture.log),
        "sigterm",
        "the stop must try the graceful signal first",
      );
    }),
  );

  it.live("kills a backend that outlives the stop's own budget", () =>
    Effect.gen(function* () {
      const fixture = yield* writeBackendScript(STUBBORN_BACKEND_SOURCE);
      const instance = yield* makeTestInstance(fixture);

      yield* instance.start;
      const pid = yield* awaitBackendPid(instance);
      yield* awaitFixtureReady(fixture.ready);

      // A budget shorter than the backend's own force-stop budget: the
      // graceful path cannot finish inside it, so the stop has to escalate
      // on its own. Without that escalation the desktop quits and leaves
      // the backend holding the T3 home's ownership lock.
      yield* instance.stop({ timeout: Duration.millis(200) });

      assert.isFalse(
        isProcessAlive(pid),
        "a backend that outlives the stop budget must still be killed",
      );
    }),
  );

  it.live("takes down a backend's child processes with it", () =>
    Effect.gen(function* () {
      const fixture = yield* writeBackendScript(CHILD_BACKEND_SOURCE);
      const instance = yield* makeTestInstance(fixture);

      yield* instance.start;
      const pid = yield* awaitBackendPid(instance);
      yield* awaitFixtureReady(fixture.ready);
      const childPid = pidFromLog(readFixtureLog(fixture.log), "child");
      assert.isTrue(childPid > 0, "the fixture must have started a child");
      assert.isTrue(isProcessAlive(childPid), "the child must be running before the stop");

      yield* instance.stop({ timeout: DesktopBackendManager.DEFAULT_BACKEND_STOP_TIMEOUT });

      assert.isFalse(isProcessAlive(pid), "the backend must be gone");
      assert.isFalse(
        isProcessAlive(childPid),
        "the backend's child process must not outlive the stop",
      );
    }),
  );

  it.live("leaves a cooperative backend alone once it has exited", () =>
    Effect.gen(function* () {
      const fixture = yield* writeBackendScript(COOPERATIVE_BACKEND_SOURCE);
      const instance = yield* makeTestInstance(fixture);

      yield* instance.start;
      const pid = yield* awaitBackendPid(instance);
      yield* awaitFixtureReady(fixture.ready);

      yield* instance.stop({ timeout: DesktopBackendManager.DEFAULT_BACKEND_STOP_TIMEOUT });

      assert.isFalse(isProcessAlive(pid), "the backend must be gone");
      const log = readFixtureLog(fixture.log);
      assert.include(log, "sigterm", "the stop must send the graceful signal");
      assert.notInclude(log, "sigint", "the stop must not escalate for a cooperative backend");
    }),
  );
});
