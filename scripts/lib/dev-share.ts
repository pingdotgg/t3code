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
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

export class DevShareLeaseClaimError extends Schema.TaggedErrorClass<DevShareLeaseClaimError>()(
  "DevShareLeaseClaimError",
  { leasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `could not claim cleanup ownership at ${this.leasePath}`;
  }

  get hint(): string {
    return "Check that the dev data directory is writable.";
  }
}

export const DevShareError = Schema.Union([
  TailscaleUnavailableError,
  TailnetNameMissingError,
  DevServeFailedError,
  DevShareLeaseClaimError,
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

export interface DevShareLease {
  readonly leasePath: string;
  readonly ownerId: string;
  readonly webPort: number;
}

export const claimDevShareLease = Effect.fn("devShare.claimDevShareLease")(function* (
  lease: DevShareLease,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(lease.leasePath), { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFileString(lease.leasePath, lease.ownerId)),
    Effect.mapError((cause) => new DevShareLeaseClaimError({ leasePath: lease.leasePath, cause })),
  );
  return lease;
});

export type DevShareCleanupResult =
  | { readonly status: "cleared" | "superseded" | "restored" }
  | { readonly status: "failed"; readonly explanation: string };

/**
 * Clears only the mapping this runner owns. If a successor claims the lease
 * while `tailscale serve off` is in flight, restore the same port mapping so
 * the old finalizer cannot silently disconnect the new runner.
 */
export const cleanupOwnedDevShare = Effect.fn("devShare.cleanupOwnedDevShare")(function* (
  lease: DevShareLease,
): Effect.fn.Return<
  DevShareCleanupResult,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const readOwner = fileSystem
    .readFileString(lease.leasePath)
    .pipe(Effect.option, Effect.map(Option.getOrUndefined));
  const ownerBefore = yield* readOwner;
  if (ownerBefore !== lease.ownerId) {
    return { status: "superseded" };
  }

  const result = yield* unshareDevServer(lease.webPort);
  if (!result.cleared) {
    return {
      status: "failed",
      explanation:
        result.explanation ??
        `could not remove the tailnet mapping for port ${String(lease.webPort)}`,
    };
  }

  const ownerAfter = yield* readOwner;
  if (ownerAfter === lease.ownerId) {
    return { status: "cleared" };
  }

  return yield* ensureTailscaleServe({
    localPort: lease.webPort,
    servePort: lease.webPort,
  }).pipe(
    Effect.as({ status: "restored" } as const),
    Effect.catch((cause: TailscaleCommandError) =>
      Effect.succeed({
        status: "failed",
        explanation:
          explainCommandFailure(cause) ??
          `a newer runner claimed port ${String(lease.webPort)}, but its mapping could not be restored`,
      } as const),
    ),
    Effect.uninterruptible,
  );
});

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

  yield* ensureTailscaleServe({ localPort: input.webPort, servePort: input.webPort }).pipe(
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

/**
 * Claims cleanup ownership only after the tailnet mapping exists. A failed
 * replacement must leave the prior runner as the owner so its finalizer can
 * still remove any mapping that survived the attempt.
 */
export const acquireDevShare = Effect.fn("devShare.acquireDevShare")(function* (
  lease: DevShareLease,
) {
  const shared = yield* shareDevServer({ webPort: lease.webPort });
  yield* claimDevShareLease(lease);
  return shared;
});
