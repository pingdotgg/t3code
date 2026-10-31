import { claimTailscaleServe, releaseTailscaleServe } from "@t3tools/tailscale";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
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

const failureKey = (cause: ClaimError) =>
  cause._tag === "TailscaleCommandExitError" ? `exit:${cause.stderrDiagnostic}` : cause._tag;

/**
 * Points Tailscale Serve at this server after activation and retries until it
 * succeeds. `settled` completes after the first attempt, so headless startup
 * can print the Serve URL. Shutdown removes the mapping only if it still points here.
 */
export const layer = (options: {
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
      const manualCommand = `tailscale serve --bg --https=${target.servePort} http://${target.localHost}:${target.localPort}`;
      const configured = yield* Ref.make(false);

      // Added before the retry fiber is forked, so it runs after that fiber
      // is interrupted and sees the final state.
      yield* Effect.addFinalizer(() =>
        Ref.get(configured).pipe(
          Effect.flatMap((wasConfigured) =>
            wasConfigured
              ? releaseTailscaleServe(target).pipe(
                  Effect.tap((released) =>
                    Effect.logInfo(
                      released
                        ? "Tailscale Serve disabled"
                        : "Tailscale Serve no longer points at this server; leaving it in place",
                      logContext,
                    ),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to disable Tailscale Serve", {
                      cause,
                      ...logContext,
                    }),
                  ),
                )
              : Effect.void,
          ),
        ),
      );

      let lastFailure: string | undefined;
      // The daemon applies the mapping before the CLI exits, so an interrupt
      // between the two would leave it behind with nothing to remove it.
      // Shutdown waits for the commands' own timeouts instead.
      const attempt = claimTailscaleServe(target).pipe(
        Effect.tap(() => Ref.set(configured, true)),
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
