/**
 * Shares a running dev server on the local tailnet via `tailscale serve`, so it
 * can be opened from a phone, another laptop, or by whoever is reviewing the
 * work.
 *
 * Thin wrapper over `@t3tools/tailscale` (the same client the server's own
 * `--tailscale-serve` uses). What it adds is dev-share semantics: replacing a
 * stale mapping left by a killed run, and refusing to serve over routes it
 * could not remove.
 *
 * Because browser dev is single-origin (Vite proxies the backend — see
 * `resolveDevProxyTarget` in apps/web/vite.config.ts), one proxy rule covering
 * the web port is enough; the backend needs no mapping of its own.
 */

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";

/**
 * Human-readable gloss for each diagnostic. Deliberately our own words rather
 * than the CLI's: tailscale prints auth keys and node names into stderr, and
 * this string is logged.
 */
const DIAGNOSTIC_EXPLANATIONS: Record<TailscaleStderrDiagnostic, string | undefined> = {
  "no-existing-handler": "no mapping existed for that port",
  "not-logged-in": "this machine is not logged into a tailnet — run `tailscale up`",
  "permission-denied": "permission denied — `tailscale serve` may need elevated privileges",
  unknown: undefined,
};

/**
 * Our own wording for why a tailscale command failed, derived from the
 * classified diagnostic. Never the CLI's text — see `stderrDiagnosticOf`.
 */
const explainCommandFailure = (error: TailscaleCommandError): string | undefined =>
  error._tag === "TailscaleCommandExitError" && error.stderrDiagnostic !== undefined
    ? (DIAGNOSTIC_EXPLANATIONS[error.stderrDiagnostic] ?? "run the command by hand to see why")
    : undefined;

/**
 * Three distinct failures, three classes: each has its own caller-visible
 * message and its own remedy, and `shareDevServer` chooses between them
 * structurally. A single error with a `reason` discriminator would encode that
 * distinction twice and put a lookup table in the `message` getter.
 *
 * Each wraps a real underlying failure and so keeps it as `cause`; the message
 * is derived only from the structural fields, never from `cause.message`.
 */
export class TailscaleUnavailableError extends Schema.TaggedErrorClass<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "could not talk to tailscale";
  }

  get hint(): string {
    return "Is Tailscale installed and tailscaled running? Try `tailscale status` — or drop --share and open the printed localhost URL.";
  }
}

/** No underlying failure: the status read succeeded and simply had no name. */
export class TailnetNameMissingError extends Schema.TaggedErrorClass<TailnetNameMissingError>()(
  "TailnetNameMissingError",
  {},
) {
  override get message(): string {
    return "this machine has no tailnet DNS name";
  }

  get hint(): string {
    return "Run `tailscale up` and make sure MagicDNS is enabled.";
  }
}

/**
 * `stage` is a genuine multi-value discriminator: both stages share the same
 * semantics (a `tailscale serve` invocation failed for this port) and differ
 * only in which one, which the message states plainly.
 */
export class DevServeFailedError extends Schema.TaggedErrorClass<DevServeFailedError>()(
  "DevServeFailedError",
  {
    stage: Schema.Literals(["clear-existing", "serve"]),
    webPort: Schema.Number,
    explanation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const port = String(this.webPort);
    const base =
      this.stage === "clear-existing"
        ? `could not clear the existing mapping for port ${port}. Run \`tailscale serve --https=${port} off\` and retry`
        : `could not serve port ${port} on the tailnet (it is no longer served; any previous mapping for it was cleared before this attempt)`;
    return this.explanation ? `${base}: ${this.explanation}` : base;
  }

  get hint(): undefined {
    return undefined;
  }
}

export const DevShareError = Schema.Union([
  TailscaleUnavailableError,
  TailnetNameMissingError,
  DevServeFailedError,
]);
export type DevShareError = typeof DevShareError.Type;
export const isDevShareError = Schema.is(DevShareError);

/**
 * Removes any mapping for `webPort`, reporting whether the port is now clear.
 *
 * Runs uninterruptibly: this is called from a finalizer on the way out of an
 * interrupted program, and cancelling the cleanup subprocess would leave
 * exactly the stale mapping it exists to remove.
 */
export const unshareDevServer = (
  webPort: number,
): Effect.Effect<
  {
    readonly cleared: boolean;
    readonly explanation?: string | undefined;
    // Kept structured so a caller wrapping this can preserve the real error
    // chain rather than a flattened string.
    readonly cause?: TailscaleCommandError | undefined;
  },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  disableTailscaleServe({ servePort: webPort }).pipe(
    Effect.as({ cleared: true } as const),
    Effect.catch((error: TailscaleCommandError) =>
      Effect.succeed(
        // "Nothing was mapped" leaves the port clear either way.
        error._tag === "TailscaleCommandExitError" &&
          error.stderrDiagnostic === "no-existing-handler"
          ? ({ cleared: true } as const)
          : ({
              cleared: false,
              ...(explainCommandFailure(error) !== undefined
                ? { explanation: explainCommandFailure(error) }
                : {}),
              cause: error,
            } as const),
      ),
    ),
    Effect.uninterruptible,
  );

export interface DevShareResult {
  readonly url: string;
  readonly host: string;
}

/**
 * Publishes `webPort` on the tailnet at the same port number and returns the
 * resulting HTTPS URL. Idempotent: re-running replaces any existing mapping.
 */
export const shareDevServer = Effect.fn("devShare.shareDevServer")(function* (input: {
  readonly webPort: number;
}) {
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError((error) => new TailscaleUnavailableError({ cause: error })),
  );
  if (status.magicDnsName === null) {
    return yield* new TailnetNameMissingError();
  }

  // Clear any mapping left behind by a run that was killed before its finalizer
  // could fire. Serve config survives both the process and a reboot, and a
  // stale entry may carry path routes we no longer want — older versions mapped
  // /ws, /api and friends to a separate backend port, and serving "/" alone
  // would leave those pointing at a port nothing is listening on.
  const cleared = yield* unshareDevServer(input.webPort);
  if (!cleared.cleared) {
    // Serving over routes we failed to remove would hand out a URL that is
    // broken in a way the user cannot see: the page loads while /ws and /api
    // silently resolve to a dead backend. Better to refuse and say why.
    return yield* new DevServeFailedError({
      stage: "clear-existing",
      webPort: input.webPort,
      ...(cleared.explanation !== undefined ? { explanation: cleared.explanation } : {}),
      ...(cleared.cause !== undefined ? { cause: cleared.cause } : {}),
    });
  }

  // Proxy to the hostname Vite binds rather than the package default of
  // 127.0.0.1. Vite listens on `localhost`, which Node 17+ resolves to `::1`
  // first, so it only binds the IPv6 loopback and a 127.0.0.1 target has
  // nothing behind it (tailscale answers 502). Passing `localhost` lets the
  // tailscale proxy resolve it the same way Node did. Not a literal `[::1]`:
  // tailscale rejects that form.
  yield* ensureTailscaleServe({
    localPort: input.webPort,
    servePort: input.webPort,
    localHost: "localhost",
  }).pipe(
    Effect.mapError((error) => {
      const explanation = explainCommandFailure(error);
      return new DevServeFailedError({
        stage: "serve",
        webPort: input.webPort,
        ...(explanation !== undefined ? { explanation } : {}),
        cause: error,
      });
    }),
  );

  return {
    url: buildTailscaleHttpsBaseUrl({
      magicDnsName: status.magicDnsName,
      servePort: input.webPort,
    }),
    host: status.magicDnsName,
  } satisfies DevShareResult;
});
