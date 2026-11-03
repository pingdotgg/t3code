/** Vite proxies the backend, so only the web port needs a share mapping. */

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
import type { ChildProcessSpawner } from "effect/process";

/** Log fixed diagnostics; tailscale stderr can contain auth keys and node names. */
const DIAGNOSTIC_EXPLANATIONS: Record<TailscaleStderrDiagnostic, string | undefined> = {
  "no-existing-handler": "no mapping existed for that port",
  "not-logged-in": "this machine is not logged into a tailnet — run `tailscale up`",
  "not-running": "Tailscale is not running; start it and try again",
  "permission-denied": "permission denied — `tailscale serve` may need elevated privileges",
  unknown: undefined,
};

const explainCommandFailure = (error: TailscaleCommandError): string | undefined =>
  error._tag === "TailscaleCommandExitError" && error.stderrDiagnostic !== undefined
    ? (DIAGNOSTIC_EXPLANATIONS[error.stderrDiagnostic] ?? "run the command by hand to see why")
    : undefined;

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

export class DevServeFailedError extends Schema.TaggedError<DevServeFailedError>()(
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
        ? `could not clear the existing mapping for port ${port}. Run \`tailscale serve --https=${port} --set-path=/ off\` and retry`
        : `could not serve port ${port} on the tailnet (it is no longer served; any previous mapping for it was cleared before this attempt)`;
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

/** Finalizer cleanup must be uninterruptible or cancellation can leave stale mappings. */
export const unshareDevServer = (
  webPort: number,
): Effect.Effect<
  {
    readonly cleared: boolean;
    readonly explanation?: string | undefined;
    readonly cause?: TailscaleCommandError | undefined;
  },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  disableTailscaleServe({ servePort: webPort }).pipe(
    Effect.as({ cleared: true } as const),
    Effect.catch((error: TailscaleCommandError) =>
      Effect.succeed(
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
 * Publishes `webPort` on the tailnet. The tailnet port always matches the web
 * port so the URL is stable; `localTarget` points it at the backend instead
 * when the backend serves a built client (`--built`).
 */
export const shareDevServer = Effect.fn("devShare.shareDevServer")(function* (input: {
  readonly webPort: number;
  readonly localTarget?: { readonly port: number; readonly host: string };
}) {
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError((error) => new TailscaleUnavailableError({ cause: error })),
  );
  if (status.magicDnsName === null) {
    return yield* new TailnetNameMissingError();
  }

  const cleared = yield* unshareDevServer(input.webPort);
  if (!cleared.cleared) {
    // Refuse stale routes: the page could load while /ws and /api still point at a dead backend.
    return yield* new DevServeFailedError({
      stage: "clear-existing",
      webPort: input.webPort,
      ...(cleared.explanation !== undefined ? { explanation: cleared.explanation } : {}),
      ...(cleared.cause !== undefined ? { cause: cleared.cause } : {}),
    });
  }

  // Vite's localhost can bind only ::1; a 127.0.0.1 proxy target would return 502.
  yield* ensureTailscaleServe({
    localPort: input.localTarget?.port ?? input.webPort,
    servePort: input.webPort,
    localHost: input.localTarget?.host ?? "localhost",
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
