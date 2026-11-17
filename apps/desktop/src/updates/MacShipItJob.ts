import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";

// Squirrel.Mac leaves this job loaded after an update, so the Dock shows us running after quit (Squirrel.Mac#331).
const SHIPIT_LABEL = "com.t3tools.t3code.ShipIt";

const { logInfo, logWarning } = makeComponentLogger("desktop-mac-shipit-job");

const launchctl = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("/bin/launchctl", args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [output, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );
      return { output, exitCode };
    }),
  ).pipe(Effect.timeout("5 seconds"));

export const removeLeftoverShipItJob = Effect.fn("desktop.macShipItJob.removeLeftover")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const uid = yield* HostProcess.UserId;
    if (environment.platform !== "darwin" || !environment.isPackaged || uid === undefined) return;

    const target = `gui/${uid}/${SHIPIT_LABEL}`;
    // A running ShipIt is installing an update or relaunching us; the next launch removes it.
    const isLoadedAndIdle = launchctl(["print", target]).pipe(
      Effect.map((job) => job.exitCode === 0 && !/^\s*pid = \d+\s*$/m.test(job.output)),
    );
    if (!(yield* isLoadedAndIdle)) return;
    // ShipIt can start between the check and the unload, so check again right before it.
    if (!(yield* isLoadedAndIdle)) return;

    const bootout = yield* launchctl(["bootout", target]);
    if (bootout.exitCode !== 0) {
      return yield* logWarning("could not remove the leftover ShipIt job", {
        exitCode: bootout.exitCode,
      });
    }
    yield* logInfo("removed the leftover ShipIt job");
  },
  Effect.catchCause((cause) => logWarning("could not remove the leftover ShipIt job", { cause })),
);
