import { claimTailscaleServe, releaseTailscaleServe } from "@t3tools/tailscale";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";

import { loopbackUrlHostForAddress } from "./startupAccess.ts";

type ClaimError = Effect.Error<ReturnType<typeof claimTailscaleServe>>;

// Serve is often refused only for now: Tailscale still starting at login, the
// operator or HTTPS certs not yet granted, or another server on the port.
// Nobody restarts a headless server once that is fixed, so keep retrying.
const retrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

const remedyFor = (cause: ClaimError, manualCommand: string) => {
  if (cause._tag === "TailscaleServeOccupiedError") {
    return "Another server holds this port. T3 Code leaves it alone and takes over once it stops.";
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
const encodeClaim = Schema.encodeEffect(ServeClaim);
const decodeClaim = Schema.decodeUnknownEffect(ServeClaim);

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
      // Recorded before the first claim, since a claim can apply the mapping and still fail.
      // Release removes only a root that points here, so it is safe when no claim landed.
      yield* encodeClaim(target).pipe(
        Effect.flatMap((claim) =>
          fs
            .makeDirectory(options.stateDir, { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(claimPath, claim))),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not record the Tailscale Serve mapping", { cause }),
        ),
      );
      // Added before the retry fiber is forked, so it runs after that fiber is interrupted.
      yield* Effect.addFinalizer(() =>
        releaseTailscaleServe(target).pipe(
          Effect.tap(() => fs.remove(claimPath, { force: true })),
          Effect.tap((released) =>
            released ? Effect.logInfo("Tailscale Serve disabled", logContext) : Effect.void,
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to disable Tailscale Serve", { cause, ...logContext }),
          ),
        ),
      );

      let lastFailure: string | undefined;
      // The daemon applies the mapping before the CLI exits, so an interrupt
      // between the two would leave it behind with nothing to remove it.
      // Shutdown waits for the commands' own timeouts instead.
      const attempt = claimTailscaleServe(target).pipe(
        Effect.uninterruptible,
        Effect.tap(() => Effect.logInfo("Tailscale Serve configured", logContext)),
        Effect.tapError((cause) => {
          const key = failureKey(cause);
          const repeated = key === lastFailure;
          lastFailure = key;
          const log = repeated ? Effect.logDebug : Effect.logWarning;
          return log(
            `Failed to configure Tailscale Serve. ${remedyFor(cause, manualCommand)} Retrying in the background.`,
            { cause, ...logContext },
          );
        }),
        Effect.ensuring(Deferred.succeed(options.settled, undefined)),
      );

      yield* attempt.pipe(Effect.retry(retrySchedule), Effect.forkScoped);
    }),
  );

/**
 * With Serve off, removes the mapping an earlier run set up but could not remove, and
 * retries until Tailscale answers. Does nothing when no such mapping was recorded.
 */
export const layerReleaseLeftover = (options: { readonly stateDir: string }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const claimPath = (yield* Path.Path).join(options.stateDir, CLAIM_FILE);
      const raw = yield* fs.readFileString(claimPath).pipe(Effect.option);
      if (Option.isNone(raw)) return;
      const claim = yield* decodeClaim(raw.value).pipe(Effect.option);
      yield* (
        Option.isNone(claim)
          ? Effect.void
          : releaseTailscaleServe(claim.value).pipe(
              Effect.retry(retrySchedule),
              Effect.tap((released) =>
                released
                  ? Effect.logInfo(
                      "Removed the Tailscale Serve mapping left from when Serve was on",
                    )
                  : Effect.void,
              ),
            )
      ).pipe(
        Effect.andThen(fs.remove(claimPath, { force: true })),
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove the leftover Tailscale Serve record", { cause }),
        ),
        Effect.forkScoped,
      );
    }),
  );
