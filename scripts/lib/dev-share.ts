/** Vite proxies the backend, so only the web port needs a share mapping. */

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  inspectTailscaleServePort,
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

/** Log fixed diagnostics; tailscale stderr can contain auth keys and node names. */
const DIAGNOSTIC_EXPLANATIONS: Record<TailscaleStderrDiagnostic, string | undefined> = {
  "no-existing-handler": "no mapping existed for that port",
  "peer-not-found": "no tailnet node has that address",
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

export class DevSharePortTakenError extends Schema.TaggedError<DevSharePortTakenError>()(
  "DevSharePortTakenError",
  { webPort: Schema.Number, target: Schema.String },
) {
  override get message(): string {
    return `tailnet port ${String(this.webPort)} already forwards to ${this.target}, which is still answering`;
  }

  get hint(): string {
    return `Another server owns that mapping, so it was left alone. Stop that server, or run \`tailscale serve --https=${String(this.webPort)} off\` if the mapping is yours.`;
  }
}

export type DevShareError =
  | TailscaleUnavailableError
  | TailnetNameMissingError
  | DevSharePortTakenError
  | DevServeFailedError;

export interface DevShareTarget {
  readonly webPort: number;
  /** Where the tailnet port forwards; the web port on Vite's host unless `--built`. */
  readonly localTarget?: { readonly port: number; readonly host: string };
}

// Proxy to the hostname Vite binds rather than the package default of
// 127.0.0.1. Vite listens on `localhost`, which Node 17+ resolves to `::1`
// first, so it only binds the IPv6 loopback and a 127.0.0.1 target has
// nothing behind it (tailscale answers 502).
const localTargetOf = (input: DevShareTarget) => ({
  localPort: input.localTarget?.port ?? input.webPort,
  localHost: input.localTarget?.host ?? "localhost",
});

interface UnshareResult {
  readonly cleared: boolean;
  readonly explanation?: string | undefined;
  readonly cause?: TailscaleCommandError | undefined;
  /** The port forwards to another server, so its mapping was left in place. */
  readonly notOurs?: boolean;
}

const clearServePort = (
  webPort: number,
): Effect.Effect<UnshareResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
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
  );

/** Uninterruptible finalizer cleanup removes only our mapping, so it cannot disconnect another server. */
export const unshareDevServer = (
  input: DevShareTarget,
): Effect.Effect<
  UnshareResult,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
  inspectTailscaleServePort({ ...localTargetOf(input), servePort: input.webPort }).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.succeed({
          cleared: false,
          explanation: "could not read `tailscale serve status`, so the mapping was left in place",
        }),
      onSuccess: (ownership) =>
        ownership._tag === "ours"
          ? clearServePort(input.webPort)
          : Effect.succeed({ cleared: true, notOurs: ownership._tag !== "free" }),
    }),
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
export const shareDevServer = Effect.fn("devShare.shareDevServer")(function* (
  input: DevShareTarget,
) {
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError((error) => new TailscaleUnavailableError({ cause: error })),
  );
  if (status.magicDnsName === null) {
    return yield* new TailnetNameMissingError();
  }

  const local = localTargetOf(input);
  const ownership = yield* inspectTailscaleServePort({ ...local, servePort: input.webPort }).pipe(
    Effect.mapError((error) => new TailscaleUnavailableError({ cause: error })),
  );
  if (ownership._tag === "taken") {
    return yield* new DevSharePortTakenError({ webPort: input.webPort, target: ownership.target });
  }

  // Only our own or a stale mapping reaches here. Clearing first drops any
  // path handlers (/api, /ws) an older mapping left on the port.
  const cleared = yield* clearServePort(input.webPort);
  if (!cleared.cleared) {
    // Refuse stale routes: the page could load while /ws and /api still point at a dead backend.
    return yield* new DevServeFailedError({
      stage: "clear-existing",
      webPort: input.webPort,
      ...(cleared.explanation !== undefined ? { explanation: cleared.explanation } : {}),
      ...(cleared.cause !== undefined ? { cause: cleared.cause } : {}),
    });
  }

  yield* ensureTailscaleServe({ ...local, servePort: input.webPort }).pipe(
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
