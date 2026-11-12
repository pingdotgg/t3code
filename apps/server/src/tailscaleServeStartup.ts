import type { TailscaleCommandError } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as SubscriptionRef from "effect/SubscriptionRef";

/** Why requested Serve is not set up yet, with the fix; holds undefined once it is. Absent without Serve. */
export class TailscaleServeStatus extends Context.Reference<
  SubscriptionRef.SubscriptionRef<string | undefined> | undefined
>("t3/TailscaleServeStatus", { defaultValue: () => undefined }) {}

const TAILSCALE_SERVE_RETRY_MAX_DELAY = Duration.minutes(1);

const tailscaleServeRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, TAILSCALE_SERVE_RETRY_MAX_DELAY)),
  ),
);

/** What the user can do about a failed `tailscale serve`; its stderr is never quoted. */
export const tailscaleServeFailureHint = (error: TailscaleCommandError): string => {
  switch (error._tag) {
    case "TailscaleCommandSpawnError":
      return "Install Tailscale and make sure the tailscale CLI is on PATH.";
    case "TailscaleCommandExitError":
      switch (error.stderrDiagnostic) {
        case "not-running":
          return "Start Tailscale; T3 Code keeps retrying until it is up.";
        case "not-logged-in":
          return "Log in with `tailscale up`; T3 Code keeps retrying.";
        case "permission-denied":
          return "Allow this user to configure Serve with `sudo tailscale set --operator=$USER`.";
        default:
          return "Run `tailscale serve status` for details; Serve also needs MagicDNS and HTTPS certificates enabled for the tailnet.";
      }
    default:
      return "Check that Tailscale is running; T3 Code keeps retrying.";
  }
};

const failureKind = (error: TailscaleCommandError) =>
  error._tag === "TailscaleCommandExitError"
    ? `${error._tag}:${error.stderrDiagnostic ?? ""}`
    : error._tag;

/**
 * Retries Serve setup until it succeeds: Tailscale is often not up yet after a reboot, and a
 * permission fix takes effect without a restart. `onFailure` runs when the failure kind changes,
 * so a host that stays broken logs once rather than every minute.
 */
export const retryTailscaleServe = <R, R2>(
  ensure: Effect.Effect<void, TailscaleCommandError, R>,
  onFailure: (error: TailscaleCommandError) => Effect.Effect<void, never, R2>,
) =>
  Effect.suspend(() => {
    let lastKind: string | undefined;
    return ensure.pipe(
      Effect.tapError((error) => {
        const kind = failureKind(error);
        if (kind === lastKind) return Effect.void;
        lastKind = kind;
        return onFailure(error);
      }),
      Effect.retry(tailscaleServeRetrySchedule),
    );
  });
