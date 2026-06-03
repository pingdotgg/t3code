import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

/**
 * Wait for the child to exit (with timeout). Uses `handle.isRunning`
 * rather than `handle.exitCode` because the latter raises a
 * `PlatformError` for processes killed by signal (no exit code), which
 * is a perfectly normal outcome for the SIGKILL test cases.
 */
export const waitForExit = (
  handle: ChildProcessHandle,
  timeout: Duration.Input,
): Effect.Effect<void, Error> =>
  handle.isRunning.pipe(
    Effect.orElseSucceed(() => false),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(50)),
      until: (running) => !running,
    }),
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error("child did not exit in time")),
    ),
  );

export const assertPidExited = (pid: number): Effect.Effect<void, Error> =>
  isAlive(pid).pipe(
    Effect.orElseSucceed(() => false),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(50)),
      until: (alive) => !alive,
    }),
    Effect.timeout("5 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error("child did not exit in time")),
    ),
  );

/**
 * `process.kill(pid, 0)` is a sync syscall that probes a pid we don't
 * own a handle to (e.g. a grandchild spawned by the parent fixture).
 * Wrapped in `Effect.sync` so it participates in the runtime.
 */
export const isAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Resolves the pid currently LISTENing on the port of `wsUrl`. Uses an
 * `lsof` invocation; we don't own a handle to whatever process is
 * listening so there's no ChildProcessHandle equivalent.
 */
export const pidListeningOn = (wsUrl: string) =>
  ChildProcess.make(
    "lsof",
    ["-iTCP:" + new URL(wsUrl).port, "-sTCP:LISTEN", "-t"],
    {
      stdout: "pipe",
    },
  ).pipe(
    Effect.flatMap((handle) =>
      handle.stdout.pipe(Stream.decodeText, Stream.mkString),
    ),
    Effect.map((stdout) => Number.parseInt(stdout.trim().split("\n")[0]!, 10)),
  );

/** Send a signal to a pid we don't own a handle to. */
export const killPid = (
  pid: number,
  signal: NodeJS.Signals,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal);
    } catch {}
  });

/**
 * Open a WebSocket inside a scope so it's reliably closed at scope
 * end. Resolves once `open` fires or fails on error / close.
 */
export const openWebSocket = (
  url: string | URL,
): Effect.Effect<WebSocket, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, Error>((resume) => {
      const ws = new WebSocket(url);
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resume(Effect.succeed(ws));
      };
      const onError = () => {
        cleanup();
        try {
          ws.close();
        } catch {}
        resume(Effect.fail(new Error(`websocket connect failed: ${url}`)));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    }),
    (ws) =>
      Effect.sync(() => {
        try {
          ws.close();
        } catch {}
      }),
  );

/** Probe whether a websocket can be opened. Never fails. */
export const canOpenWebSocket = (
  url: string | URL,
  timeout: Duration.Input = Duration.millis(1_500),
): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const ws = new WebSocket(url);
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      resume(Effect.succeed(v));
    };
    ws.addEventListener("open", () => settle(true), { once: true });
    ws.addEventListener("error", () => settle(false), { once: true });
    ws.addEventListener("close", () => settle(false), { once: true });
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.succeed(false),
    }),
  );
