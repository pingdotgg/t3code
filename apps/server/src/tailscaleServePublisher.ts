import type { TailscaleCommandError, TailscaleServeHttpsDisabledError } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

const TAILSCALE_SERVE_RETRY_INTERVAL = "30 seconds";

/** Why Tailscale Serve is off although it was requested, with a remedy; undefined once it is on. */
export class TailscaleServeProblem extends Context.Reference<
  SubscriptionRef.SubscriptionRef<string | undefined> | undefined
>("t3/tailscaleServeProblem", { defaultValue: () => undefined }) {}

export interface TailscaleServeRoute {
  readonly localPort: number;
  readonly urlHost: string;
  readonly servePort: number;
}

type TailscaleServeHolder = "none" | "ours" | "dead" | "other" | "unreadable";

const HTTPS_SETTINGS_URL = "https://login.tailscale.com/admin/dns";

const describeTailscaleServeHolder = (
  holder: "other" | "unreadable",
  route: TailscaleServeRoute,
): string =>
  holder === "other"
    ? `HTTPS port ${route.servePort} on the tailnet already serves another server or app. Choose another Tailscale Serve port.`
    : "Tailscale's Serve routes could not be read. Check that Tailscale is installed and running.";

export const describeTailscaleServeFailure = (
  cause: TailscaleCommandError | TailscaleServeHttpsDisabledError,
  route: TailscaleServeRoute,
): string => {
  const byHand = `Run \`tailscale serve --bg --https=${route.servePort} http://${route.urlHost}:${route.localPort}\` by hand to see why.`;
  switch (cause._tag) {
    case "TailscaleServeHttpsDisabledError":
      return cause.message;
    case "TailscaleCommandSpawnError":
      return "The `tailscale` command could not be started. Install Tailscale, or add its CLI to PATH.";
    // With Serve or HTTPS off for the tailnet the CLI prints an enable link and waits, so a running
    // Tailscale times out too.
    case "TailscaleCommandTimeoutError":
      return `\`tailscale serve\` did not answer within ${cause.timeoutMs / 1000} seconds. Check that Tailscale is running, and that Serve and HTTPS certificates are enabled for your tailnet at ${HTTPS_SETTINGS_URL}.`;
    case "TailscaleCommandOutputError":
      return `The output of \`tailscale serve\` could not be read. ${byHand}`;
    case "TailscaleCommandExitError":
      switch (cause.stderrDiagnostic) {
        case "permission-denied":
          return "Tailscale denied this user access to Serve. On Linux, run `sudo tailscale set --operator=$USER` once.";
        case "not-running":
          return "Tailscale is not running. Start Tailscale.";
        case "not-logged-in":
          return "Tailscale is logged out. Run `tailscale up` to log in.";
        case "unsupported-target":
          return `This Tailscale install can only proxy to localhost, not ${route.urlHost}. Bind --host 127.0.0.1 or 0.0.0.0 instead.`;
        default:
          return `\`tailscale serve\` exited with code ${cause.exitCode}. ${byHand}`;
      }
  }
};

/**
 * Publishes `route` and keeps it published: retries until the first success, and afterwards takes
 * the route back when it is found on a dead port. A route removed after a success stays removed.
 */
export const keepTailscaleServePublished = Effect.fn("tailscaleServe.keepPublished")(function* <
  R1,
  R2,
>(input: {
  readonly route: TailscaleServeRoute;
  readonly readHolder: Effect.Effect<TailscaleServeHolder, never, R1>;
  readonly ensure: Effect.Effect<
    void,
    TailscaleCommandError | TailscaleServeHttpsDisabledError,
    R2
  >;
  readonly problem: SubscriptionRef.SubscriptionRef<string | undefined>;
}) {
  const { route } = input;
  const annotations = { localPort: route.localPort, servePort: route.servePort };
  const report = Effect.fn("tailscaleServe.report")(function* (
    problem: string | undefined,
    cause?: unknown,
  ) {
    if ((yield* SubscriptionRef.get(input.problem)) === problem) return;
    yield* SubscriptionRef.set(input.problem, problem);
    if (problem !== undefined) {
      yield* Effect.logWarning(
        `Tailscale Serve is off and is retried every ${TAILSCALE_SERVE_RETRY_INTERVAL}. ${problem}`,
        cause === undefined ? annotations : { ...annotations, cause },
      );
    }
  });

  let published = false;
  let startup = true;
  while (true) {
    const holder = yield* input.readHolder;
    if (holder === "other" || holder === "unreadable") {
      if (!published) yield* report(describeTailscaleServeHolder(holder, route));
    } else if (holder === "dead" || (!published && (holder === "none" || startup))) {
      const failure = yield* input.ensure.pipe(
        Effect.as(undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      );
      if (failure === undefined) {
        yield* report(undefined);
        yield* Effect.logInfo(
          published ? "Tailscale Serve repaired" : "Tailscale Serve configured",
          annotations,
        );
        published = true;
      } else if (!published) {
        yield* report(describeTailscaleServeFailure(failure, route), failure);
      }
    } else if (holder === "ours") {
      yield* report(undefined);
      published = true;
    }
    startup = false;
    yield* Effect.sleep(TAILSCALE_SERVE_RETRY_INTERVAL);
  }
});
