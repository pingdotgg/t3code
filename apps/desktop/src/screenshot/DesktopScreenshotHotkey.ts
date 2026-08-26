// Codex-style screenshot hotkey (macOS only). A Swift sidecar
// (native/screenshot-helper) reports raw left/right ⌘ state over stdout and
// captures the frontmost OS window on request over stdin; this service owns
// the helper's lifecycle, decides chords with the pure ScreenshotChord
// handler, and pushes the captured PNG (as a data URL) to the renderer via
// DesktopWindow. `reconcile` is the single entry point: bootstrap calls it
// once, and the client-settings IPC handler calls it after every settings
// write so toggling the setting starts/stops the helper.

import { DEFAULT_CLIENT_SETTINGS, type DesktopScreenshotHotkeyEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { makeScreenshotChordHandler } from "./ScreenshotChord.ts";

const CAPTURE_TIMEOUT = "15 seconds";
const HELPER_TERMINATE_GRACE = "2 seconds";
// A helper that keeps dying young is broken (missing dylib, rejected by
// Gatekeeper, …): back off, then latch off until the next reconcile.
const HELPER_FAST_EXIT_WINDOW_MS = 30_000;
const HELPER_MAX_FAST_EXITS = 5;
const HELPER_RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000] as const;

const { logInfo: logHotkeyInfo, logWarning: logHotkeyWarning } = makeComponentLogger(
  "desktop-screenshot-hotkey",
);

const CaptureReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("capture"),
    id: Schema.optionalKey(Schema.String),
    ok: Schema.Literal(true),
    path: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
    appName: Schema.optionalKey(Schema.String),
    windowBounds: Schema.optionalKey(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("capture"),
    id: Schema.optionalKey(Schema.String),
    ok: Schema.Literal(false),
    reason: Schema.Literals(["permission-denied", "no-window", "capture-failed"]),
  }),
]);
type CaptureReply = typeof CaptureReply.Type;

const HelperEvent = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("ready"), version: Schema.Number }),
    Schema.Struct({
      type: Schema.Literal("flags"),
      left: Schema.Boolean,
      right: Schema.Boolean,
    }),
    ...CaptureReply.members,
  ]),
);
const decodeHelperEvent = Schema.decodeEffect(HelperEvent);

interface HelperSession {
  readonly commands: Queue.Queue<string, Cause.Done>;
}

interface PendingCapture {
  readonly id: string;
  readonly deferred: Deferred.Deferred<CaptureReply>;
}

export class DesktopScreenshotHotkey extends Context.Service<
  DesktopScreenshotHotkey,
  {
    // Start or stop the helper to match platform + the screenshotHotkey
    // setting. Never fails; problems are logged and the feature stays off.
    readonly reconcile: Effect.Effect<void>;
  }
>()("@t3tools/desktop/screenshot/DesktopScreenshotHotkey") {}

const HELPER_BINARY_NAME = "t3-screenshot-helper";

const resolveHelperPath = Effect.fn("desktop.screenshotHotkey.resolveHelperPath")(function* (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  fileSystem: FileSystem.FileSystem,
) {
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/screenshot-helper/build",
          HELPER_BINARY_NAME,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "screenshot-helper", HELPER_BINARY_NAME)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("screenshot-helper", HELPER_BINARY_NAME),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

type DesktopScreenshotHotkeyServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopClientSettings.DesktopClientSettings
  | DesktopWindow.DesktopWindow
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;

  const context = yield* Effect.context<DesktopScreenshotHotkeyServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const reconcileMutex = yield* Semaphore.make(1);
  const supervisorFiberRef = yield* Ref.make(Option.none<Fiber.Fiber<void>>());
  const sessionRef = yield* Ref.make(Option.none<HelperSession>());
  const pendingCaptureRef = yield* Ref.make(Option.none<PendingCapture>());
  const captureCounterRef = yield* Ref.make(0);
  // Set before deliberately killing the helper (fresh-TCC restart after a
  // permission denial) so the supervisor doesn't count it as a crash.
  const intentionalRestartRef = yield* Ref.make(false);

  const isEnabledSetting = clientSettings.get.pipe(
    Effect.map(
      Option.match({
        onNone: () => DEFAULT_CLIENT_SETTINGS.screenshotHotkey,
        onSome: (settings) => settings.screenshotHotkey,
      }),
    ),
  );

  const dispatchEvent = (event: DesktopScreenshotHotkeyEvent) =>
    desktopWindow.dispatchScreenshotHotkeyEvent(event).pipe(
      Effect.catchCause((cause) =>
        logHotkeyWarning("could not dispatch screenshot hotkey event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const handleCaptureReply = Effect.fn("desktop.screenshotHotkey.handleCaptureReply")(function* (
    reply: Option.Option<CaptureReply>,
  ) {
    if (Option.isNone(reply)) {
      yield* logHotkeyWarning("capture timed out");
      yield* dispatchEvent({ type: "error", reason: "capture-failed" });
      return;
    }
    const capture = reply.value;
    if (!capture.ok) {
      yield* logHotkeyWarning("capture failed", { reason: capture.reason });
      if (capture.reason === "permission-denied") {
        // The TCC verdict is cached per-process: restart the helper so a
        // grant made right now works on the next chord without relaunching
        // the app. The supervisor respawns it after the exit.
        yield* Ref.set(intentionalRestartRef, true);
        // Ending the command queue closes the helper's stdin; it exits on EOF.
        yield* Ref.get(sessionRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (session) => Queue.end(session.commands),
            }),
          ),
        );
        yield* dispatchEvent({ type: "error", reason: "permission-denied" });
      } else {
        yield* dispatchEvent({ type: "error", reason: "capture-failed" });
      }
      return;
    }
    const bytes = yield* fileSystem.readFile(capture.path).pipe(Effect.option);
    yield* fileSystem.remove(capture.path).pipe(Effect.ignore);
    if (Option.isNone(bytes)) {
      yield* logHotkeyWarning("could not read captured screenshot", { path: capture.path });
      yield* dispatchEvent({ type: "error", reason: "capture-failed" });
      return;
    }
    yield* dispatchEvent({
      type: "captured",
      dataUrl: `data:image/png;base64,${Buffer.from(bytes.value).toString("base64")}`,
      width: capture.width,
      height: capture.height,
      ...(capture.appName !== undefined ? { appName: capture.appName } : {}),
      ...(capture.windowBounds !== undefined ? { windowBounds: capture.windowBounds } : {}),
    });
  });

  // Clears only its own pending entry: an unconditional clear could wipe out
  // a newer capture registered after this one already finished.
  const clearPendingCapture = (deferred: Deferred.Deferred<CaptureReply>) =>
    Ref.update(pendingCaptureRef, (pending) =>
      Option.isSome(pending) && pending.value.deferred === deferred ? Option.none() : pending,
    );

  const runCapture = Effect.gen(function* () {
    const session = yield* Ref.get(sessionRef);
    if (Option.isNone(session)) return;
    const existing = yield* Ref.get(pendingCaptureRef);
    // A capture is already in flight; drop the chord instead of queueing.
    if (Option.isSome(existing)) return;
    const id = `c${yield* Ref.getAndUpdate(captureCounterRef, (n) => n + 1)}`;
    const deferred = yield* Deferred.make<CaptureReply>();
    yield* Ref.set(pendingCaptureRef, Option.some({ id, deferred }));
    yield* Effect.gen(function* () {
      // A false offer means the queue is already ended (helper mid-restart):
      // bail now instead of holding the pending slot for the full timeout.
      const offered = yield* Queue.offer(session.value.commands, `capture ${id}\n`);
      if (!offered) return;
      const reply = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(CAPTURE_TIMEOUT));
      yield* clearPendingCapture(deferred);
      yield* handleCaptureReply(reply);
    }).pipe(
      // Whatever happens above, a dead capture must never leave its pending
      // entry behind — future chords would see it as in-flight and no-op.
      Effect.ensuring(clearPendingCapture(deferred)),
    );
  }).pipe(Effect.withSpan("desktop.screenshotHotkey.capture"));

  const chordHandler = makeScreenshotChordHandler({
    isEnabled: () => runPromise(isEnabledSetting),
    capture: () => {
      runFork(runCapture);
    },
  });

  const handleHelperLine = (line: string) =>
    decodeHelperEvent(line).pipe(
      Effect.flatMap((event) => {
        switch (event.type) {
          case "ready":
            return logHotkeyInfo("helper ready", { version: event.version });
          case "flags":
            return Effect.sync(() => {
              chordHandler(event);
            });
          case "capture":
            return Ref.get(pendingCaptureRef).pipe(
              Effect.flatMap((pending) => {
                if (Option.isSome(pending) && pending.value.id === event.id) {
                  return Deferred.succeed(pending.value.deferred, event);
                }
                // Unrequested or stale (a late reply after its capture timed
                // out): its screenshot must not leak into the temp directory
                // — or into a later capture's attach.
                return logHotkeyWarning("dropping unmatched capture reply", {
                  replyId: event.id ?? null,
                }).pipe(
                  Effect.andThen(
                    event.ok ? fileSystem.remove(event.path).pipe(Effect.ignore) : Effect.void,
                  ),
                );
              }),
            );
        }
      }),
      Effect.catchTags({
        SchemaError: () => logHotkeyWarning("ignored invalid helper line", { line }),
      }),
    );

  const runHelperOnce = Effect.fn("desktop.screenshotHotkey.runHelperOnce")(function* (
    helperPath: string,
  ) {
    const commands = yield* Queue.make<string, Cause.Done>();
    const command = ChildProcess.make(helperPath, [], {
      // stdin stays open for the queue's lifetime; Queue.end closes it and
      // the helper exits on EOF.
      stdin: Stream.fromQueue(commands).pipe(Stream.encodeText),
      stdout: "pipe",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: HELPER_TERMINATE_GRACE,
    });
    const handle = yield* spawner.spawn(command);
    yield* Ref.set(sessionRef, Option.some({ commands }));
    yield* logHotkeyInfo("helper started", { pid: Number(handle.pid), helperPath });
    // The stdout stream ends when the helper exits, so draining it is the
    // session's lifetime. Kill only through the spawn scope (handle-tracked
    // PID), never by pattern.
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach(handleHelperLine),
      Effect.catchCause((cause) =>
        logHotkeyWarning("helper output stream stopped", { cause: Cause.pretty(cause) }),
      ),
    );
    const exitCode = yield* handle.exitCode.pipe(Effect.option);
    yield* logHotkeyInfo("helper exited", {
      exitCode: Option.getOrNull(exitCode),
    });
  });

  const failPendingCapture = Ref.getAndSet(pendingCaptureRef, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (pending) =>
          Deferred.succeed(pending.deferred, {
            type: "capture",
            ok: false,
            reason: "capture-failed",
          } as const).pipe(Effect.asVoid),
      }),
    ),
  );

  const superviseHelper = Effect.fn("desktop.screenshotHotkey.superviseHelper")(function* (
    helperPath: string,
  ) {
    let fastExits = 0;
    let restarts = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Effect.scoped(runHelperOnce(helperPath)).pipe(
        Effect.catchCause((cause) =>
          logHotkeyWarning("helper run failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.ensuring(Ref.set(sessionRef, Option.none())),
      );
      yield* failPendingCapture;
      const uptime = (yield* Clock.currentTimeMillis) - startedAt;
      const intentional = yield* Ref.getAndSet(intentionalRestartRef, false);
      // A healthy run forgives past instability: without this, one crash long
      // after a rough start would still wait the maximum backoff.
      if (uptime >= HELPER_FAST_EXIT_WINDOW_MS) {
        restarts = 0;
      }
      if (!intentional) {
        fastExits = uptime < HELPER_FAST_EXIT_WINDOW_MS ? fastExits + 1 : 1;
        if (fastExits >= HELPER_MAX_FAST_EXITS) {
          yield* logHotkeyWarning("helper keeps exiting; screenshot hotkey latched off", {
            fastExits,
          });
          // Parked, not returned: reconcile treats a live fiber as "running",
          // so staying parked keeps the off/on toggle as the recovery path.
          return yield* Effect.never;
        }
      }
      const backoff =
        HELPER_RESTART_BACKOFF_MS[Math.min(restarts, HELPER_RESTART_BACKOFF_MS.length - 1)] ??
        HELPER_RESTART_BACKOFF_MS[0];
      restarts += 1;
      yield* Effect.sleep(backoff);
    }
  });

  const reconcile = Effect.gen(function* () {
    const desired = environment.platform === "darwin" && (yield* isEnabledSetting);
    const current = yield* Ref.get(supervisorFiberRef);
    if (desired && Option.isNone(current)) {
      const helperPath = yield* resolveHelperPath(environment, fileSystem);
      if (Option.isNone(helperPath)) {
        yield* logHotkeyWarning(
          "screenshot helper binary not found; screenshot hotkey unavailable",
        );
        return;
      }
      yield* logHotkeyInfo("starting screenshot hotkey", { helperPath: helperPath.value });
      const fiber = runFork(superviseHelper(helperPath.value));
      yield* Ref.set(supervisorFiberRef, Option.some(fiber));
    } else if (!desired && Option.isSome(current)) {
      yield* logHotkeyInfo("stopping screenshot hotkey");
      yield* Ref.set(supervisorFiberRef, Option.none());
      yield* Fiber.interrupt(current.value);
      yield* failPendingCapture;
    }
  }).pipe(
    reconcileMutex.withPermits(1),
    Effect.catchCause((cause) =>
      logHotkeyWarning("reconcile failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("desktop.screenshotHotkey.reconcile"),
  );

  return DesktopScreenshotHotkey.of({ reconcile });
});

export const layer = Layer.effect(DesktopScreenshotHotkey, make);
