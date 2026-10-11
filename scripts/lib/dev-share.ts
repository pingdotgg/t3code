/**
 * Shares a running dev server on the local tailnet via `tailscale serve`, so it
 * can be opened from a phone, another laptop, or by whoever is reviewing the
 * work.
 *
 * Thin wrapper over `@t3tools/tailscale` (the same client the server's own
 * `--tailscale-serve` uses). Dev sharing reuses its own mapping and preserves
 * other applications' routes, including during cleanup.
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
  type TailscaleServeStatusParseError,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

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

/** Wraps a status failure without exposing CLI output. */
export class TailscaleUnavailableError extends Schema.TaggedError<TailscaleUnavailableError>()(
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
export class TailnetNameMissingError extends Schema.TaggedError<TailnetNameMissingError>()(
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

/** Keeps the underlying serve failure without exposing CLI output. */
export class DevServeFailedError extends Schema.TaggedError<DevServeFailedError>()(
  "DevServeFailedError",
  {
    webPort: Schema.Number,
    explanation: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const base = `could not serve port ${this.webPort} on the tailnet`;
    return this.explanation ? `${base}: ${this.explanation}` : base;
  }

  get hint(): undefined {
    return undefined;
  }
}

export type DevShareError =
  | TailscaleUnavailableError
  | TailnetNameMissingError
  | DevServeFailedError;

/**
 * Removes only the matching dev proxy, reporting whether the port is now clear.
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
    readonly cause?: TailscaleCommandError | TailscaleServeStatusParseError | undefined;
  },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  disableTailscaleServe({ localPort: webPort, servePort: webPort, localHost: "localhost" }).pipe(
    Effect.map((cleared) => ({ cleared })),
    Effect.catch((error) =>
      Effect.succeed({
        cleared: false,
        explanation:
          error._tag === "TailscaleServeStatusParseError"
            ? "could not read the existing tailscale serve configuration"
            : explainCommandFailure(error),
        cause: error,
      }),
    ),
    Effect.uninterruptible,
  );

export interface DevShareResult {
  readonly url: string;
  readonly host: string;
}

/**
 * Publishes `webPort` on the tailnet at the same port number and returns the
 * resulting HTTPS URL. Reuses a matching mapping and refuses occupied ports.
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
      const explanation =
        error._tag === "TailscaleServePortOccupiedError"
          ? "an existing tailscale serve handler uses this port; it was preserved. Choose another dev web port by setting T3CODE_PORT_OFFSET"
          : error._tag === "TailscaleServeStatusParseError"
            ? "could not read the existing tailscale serve configuration"
            : explainCommandFailure(error);
      return new DevServeFailedError({
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
