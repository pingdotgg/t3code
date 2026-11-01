import { claimTailscaleServe, releaseTailscaleServe } from "@t3tools/tailscale";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";

import { loopbackUrlHostForAddress } from "./startupAccess.ts";

type ClaimError =
  | Effect.Error<ReturnType<typeof claimTailscaleServe>>
  | Effect.Error<ReturnType<typeof releaseTailscaleServe>>
  | PlatformError.PlatformError;

// Serve is often refused only for now: Tailscale still starting at login, the
// operator or HTTPS certs not yet granted, or another server on the port.
// Nobody restarts a headless server once that is fixed, so keep retrying.
const retrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);
// A leftover waits on a Tailscale that may be gone for good, so it backs off further.
const leftoverSchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("10 minutes"),
]);

const remedyFor = (cause: ClaimError, manualCommand: string) => {
  if (cause._tag === "TailscaleServeOccupiedError") {
    return "Another server holds this port. T3 Code leaves it alone and takes over once it stops.";
  }
  if (cause._tag === "PlatformError") {
    return "Could not save the record that lets a later run remove the mapping, so Serve waits until it can.";
  }
  switch (cause._tag === "TailscaleCommandExitError" ? cause.stderrDiagnostic : undefined) {
    case "permission-denied":
      return "On Linux, run `sudo tailscale set --operator=$USER` to let this user configure Serve.";
    case "not-logged-in":
      return "Run `tailscale up` to log in.";
    default:
      return `Run \`${manualCommand}\` by hand to see why.`;
  }
};

/**
 * The mapping this server set up, kept until it is removed. A run with Serve off removes
 * one that is left, such as when Tailscale was down as the last run stopped.
 */
const CLAIM_FILE = "tailscale-serve-claim.json";
const ServeClaim = Schema.fromJsonString(
  Schema.Struct({ localPort: Schema.Number, localHost: Schema.String, servePort: Schema.Number }),
);
type ServeClaim = typeof ServeClaim.Type;
const encodeClaim = Schema.encodeEffect(ServeClaim);
const decodeClaim = Schema.decodeUnknownEffect(ServeClaim);
const sameTarget = (a: ServeClaim, b: ServeClaim) =>
  a.localPort === b.localPort && a.localHost === b.localHost && a.servePort === b.servePort;
const readClaim = (fs: FileSystem.FileSystem, claimPath: string) =>
  fs.readFileString(claimPath).pipe(Effect.flatMap(decodeClaim), Effect.option);
// Serve waits for the record, so a crash never leaves a mapping that nothing removes.
const writeClaim = (
  fs: FileSystem.FileSystem,
  stateDir: string,
  claimPath: string,
  claim: ServeClaim,
) =>
  encodeClaim(claim).pipe(
    Effect.orDie,
    Effect.flatMap((json) =>
      fs
        .makeDirectory(stateDir, { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(claimPath, json))),
    ),
  );

const failureKey = (cause: ClaimError) =>
  cause._tag === "TailscaleCommandExitError" ? `exit:${cause.stderrDiagnostic}` : cause._tag;

/**
 * Points Tailscale Serve at this server after activation and retries until it
 * succeeds. `settled` completes after the first attempt, so headless startup
 * can print the Serve URL. Shutdown removes the mapping only if it still points here.
 */
export const layer = (options: {
  readonly stateDir: string;
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly settled: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Deferred.succeed(options.parked, undefined).pipe(Effect.orDie);
      yield* options.awaitActivation;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        yield* Deferred.succeed(options.settled, undefined);
        return;
      }

      const target = {
        localPort: address.port,
        servePort: options.servePort,
        localHost: loopbackUrlHostForAddress(address),
      };
      const logContext = { localPort: target.localPort, servePort: target.servePort };
      const fs = yield* FileSystem.FileSystem;
      const claimPath = (yield* Path.Path).join(options.stateDir, CLAIM_FILE);
      const manualCommand = `tailscale serve --bg --https=${target.servePort} http://${target.localHost}:${target.localPort}`;
      // A record for another target is a mapping an earlier run left, so it is removed
      // first, and only while Serve still points there.
      const previous = yield* Ref.make(
        Option.filter(yield* readClaim(fs, claimPath), (claim) => !sameTarget(claim, target)),
      );
      const recorded = yield* Ref.make(false);
      // Added before the retry fiber is forked, so it runs after that fiber is interrupted.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(recorded))) return;
          const released = yield* releaseTailscaleServe(target).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Failed to disable Tailscale Serve", { cause, ...logContext }),
            ),
          );
          if (released) yield* Effect.logInfo("Tailscale Serve disabled", logContext);
          yield* fs.remove(claimPath, { force: true });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Left the Tailscale Serve record for the next run", { cause }),
          ),
        ),
      );

      let lastFailure: string | undefined;
      // The daemon applies the mapping before the CLI exits, so an interrupt
      // between the two would leave it behind with nothing to remove it.
      // Shutdown waits for the commands' own timeouts instead.
      const attempt = Effect.gen(function* () {
        const pending = yield* Ref.get(previous);
        if (Option.isSome(pending)) {
          yield* releaseTailscaleServe(pending.value);
          yield* Ref.set(previous, Option.none());
        }
        // Recorded before the claim, since a claim can apply the mapping and still fail.
        // Release removes only a root that points here, so it is safe when none landed.
        if (!(yield* Ref.get(recorded))) {
          yield* writeClaim(fs, options.stateDir, claimPath, target);
          yield* Ref.set(recorded, true);
        }
        yield* claimTailscaleServe(target);
      }).pipe(
        Effect.uninterruptible,
        Effect.tap(() => Effect.logInfo("Tailscale Serve configured", logContext)),
        Effect.tapError((cause) =>
          Effect.gen(function* () {
            const key = failureKey(cause);
            const repeated = key === lastFailure;
            lastFailure = key;
            const log = repeated ? Effect.logDebug : Effect.logWarning;
            const pending = yield* Ref.get(previous);
            yield* log(
              Option.isSome(pending)
                ? `Could not remove the Tailscale Serve mapping an earlier run left on port ${pending.value.servePort}, so Serve waits. Retrying in the background.`
                : `Failed to configure Tailscale Serve. ${remedyFor(cause, manualCommand)} Retrying in the background.`,
              { cause, ...logContext },
            );
          }),
        ),
        Effect.ensuring(Deferred.succeed(options.settled, undefined)),
      );

      yield* attempt.pipe(Effect.retry(retrySchedule), Effect.forkScoped);
    }),
  );

/**
 * Removes the Serve mapping an earlier run recorded, while Serve still points there, then
 * its record. Returns whether a mapping was removed.
 */
export const releaseRecorded = Effect.fn("TailscaleServe.releaseRecorded")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const claimPath = (yield* Path.Path).join(stateDir, CLAIM_FILE);
  const claim = yield* readClaim(fs, claimPath);
  if (Option.isNone(claim)) return false;
  const released = yield* releaseTailscaleServe(claim.value);
  yield* fs.remove(claimPath, { force: true });
  return released;
});

/**
 * With Serve off, removes the mapping an earlier run set up but could not remove, and
 * retries until Tailscale answers. Does nothing when no such mapping was recorded.
 */
export const layerReleaseLeftover = (options: { readonly stateDir: string }) =>
  Layer.effectDiscard(
    releaseRecorded(options.stateDir).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("Tailscale did not answer; retrying the leftover Serve removal", {
          cause,
        }),
      ),
      Effect.retry(leftoverSchedule),
      Effect.tap((released) =>
        released
          ? Effect.logInfo("Removed the Tailscale Serve mapping left from when Serve was on")
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove the leftover Tailscale Serve record", { cause }),
      ),
      Effect.forkScoped,
    ),
  );
