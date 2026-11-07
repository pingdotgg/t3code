import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SYSTEM_RESUME_CHANNEL } from "../ipc/channels.ts";

export const listen = Effect.gen(function* () {
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const windows = yield* ElectronWindow.ElectronWindow;
  // A visible renderer need not emit visibilitychange when the computer wakes.
  yield* Stream.callback<void>((queue) =>
    powerMonitor.onSimpleEvent("resume", () => {
      Queue.offerUnsafe(queue, undefined);
    }),
  ).pipe(
    Stream.runForEach(() =>
      windows.sendAll(SYSTEM_RESUME_CHANNEL).pipe(Effect.withSpan("desktop.connectionResume")),
    ),
    Effect.forkScoped,
  );
}).pipe(Effect.asVoid);
