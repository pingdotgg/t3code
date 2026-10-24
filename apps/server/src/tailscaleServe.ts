import {
  disableTailscaleServe,
  ensureTailscaleServe,
  type TailscaleCommandError,
} from "@t3tools/tailscale";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServer } from "effect/http";

import { loopbackUrlHostForAddress } from "./startupAccess.ts";

// Serve is often refused only for now: Tailscale still starting at login, or
// the operator or HTTPS certs not yet granted. Nobody restarts a headless
// server once that is fixed, so keep retrying.
const retrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

const remedyFor = (cause: TailscaleCommandError, manualCommand: string) => {
  const diagnostic =
    cause._tag === "TailscaleCommandExitError" ? cause.stderrDiagnostic : undefined;
  switch (diagnostic) {
    case "permission-denied":
      return "On Linux, run `sudo tailscale set --operator=$USER` to let this user configure Serve.";
    case "not-logged-in":
      return "Run `tailscale up` to log in.";
    default:
      return `Run \`${manualCommand}\` by hand to see why.`;
  }
};

const failureKey = (cause: TailscaleCommandError) =>
  cause._tag === "TailscaleCommandExitError" ? `exit:${cause.stderrDiagnostic}` : cause._tag;

export const layer = (options: {
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Deferred.succeed(options.parked, undefined).pipe(Effect.orDie);
      yield* options.awaitActivation;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        return;
      }

      const localPort = address.port;
      const servePort = options.servePort;
      const localHost = loopbackUrlHostForAddress(address);
      const manualCommand = `tailscale serve --bg --https=${servePort} http://${localHost}:${localPort}`;
      const configured = yield* Ref.make(false);

      // Added before the retry fiber is forked, so it runs after that fiber
      // is interrupted and sees the final state.
      yield* Effect.addFinalizer(() =>
        Ref.get(configured).pipe(
          Effect.flatMap((wasConfigured) =>
            wasConfigured
              ? disableTailscaleServe({ servePort }).pipe(
                  Effect.tap(() => Effect.logInfo("Tailscale Serve disabled", { servePort })),
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to disable Tailscale Serve", { cause, servePort }),
                  ),
                )
              : Effect.void,
          ),
        ),
      );

      let lastFailure: string | undefined;
      // The daemon applies the mapping before the CLI exits, so an interrupt
      // between the two would leave it behind with nothing to disable it.
      // Shutdown waits for the command's own timeout instead.
      const attempt = ensureTailscaleServe({ localPort, servePort, localHost }).pipe(
        Effect.tap(() => Ref.set(configured, true)),
        Effect.uninterruptible,
        Effect.tap(() => Effect.logInfo("Tailscale Serve configured", { localPort, servePort })),
        Effect.tapError((cause) => {
          const key = failureKey(cause);
          const repeated = key === lastFailure;
          lastFailure = key;
          const log = repeated ? Effect.logDebug : Effect.logWarning;
          return log(
            `Failed to configure Tailscale Serve. ${remedyFor(cause, manualCommand)} Retrying in the background.`,
            { cause, localPort, servePort },
          );
        }),
      );

      yield* attempt.pipe(Effect.retry(retrySchedule), Effect.forkScoped);
    }),
  );
