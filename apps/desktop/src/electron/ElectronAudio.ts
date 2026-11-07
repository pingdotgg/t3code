// @effect-diagnostics globalTimers:off -- The shared native restart deadline must outlive individual IPC callers.
// @effect-diagnostics nodeBuiltinImport:off -- Only Electron's main process can restart its Chromium audio utility.
import * as NodeProcess from "node:process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { app, type Details, type Event } from "electron";

class AudioServiceRestartError extends Schema.TaggedError<AudioServiceRestartError>()(
  "AudioServiceRestartError",
  { cause: Schema.Defect() },
) {}

let pendingRestart: Promise<boolean> | undefined;

export const restart = Effect.fn("ElectronAudio.restart")(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  return yield* Effect.tryPromise({
    try: () => {
      if (pendingRestart) return pendingRestart;
      const audio = app
        .getAppMetrics()
        .find(
          (metric) =>
            metric.type === "Utility" && metric.serviceName === "audio.mojom.AudioService",
        );
      if (!audio) return Promise.resolve(false);
      // A failed PulseAudio context survives new getUserMedia calls; Chromium reconnects when its utility exits.
      pendingRestart = new Promise<boolean>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          app.removeListener("child-process-gone", onGone);
        };
        const onGone = (_event: Event, details: Details) => {
          if (details.type === "Utility" && details.serviceName === audio.serviceName) {
            cleanup();
            resolve(true);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(false);
        }, 5_000);
        app.on("child-process-gone", onGone);
        try {
          NodeProcess.kill(audio.pid, "SIGTERM");
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      }).finally(() => {
        pendingRestart = undefined;
      });
      return pendingRestart;
    },
    catch: (cause) => new AudioServiceRestartError({ cause }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not restart the audio service", cause).pipe(Effect.as(false)),
    ),
  );
});
