import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveTailscaleExecutable } from "./executable.ts";
import {
  parseTailscaleServeConfig,
  type TailscaleServeConfigParseError,
  type TailscaleServeMount,
} from "./serveConfig.ts";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
export const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
export const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

const TailscaleCommandContext = {
  // The resolved CLI path, not a fixed name: the macOS CLI lives inside
  // Tailscale.app and never appears on a GUI app's PATH (see executable.ts).
  executable: Schema.String,
  subcommand: Schema.Literals(["status", "serve"]),
  argumentCount: Schema.Number,
};

export class TailscaleCommandSpawnError extends Schema.TaggedErrorClass<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandOutputError extends Schema.TaggedErrorClass<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedErrorClass<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedErrorClass<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export const TailscaleCommandError = Schema.Union([
  TailscaleCommandSpawnError,
  TailscaleCommandOutputError,
  TailscaleCommandExitError,
  TailscaleCommandTimeoutError,
]);
export type TailscaleCommandError = typeof TailscaleCommandError.Type;

export class TailscaleStatusParseError extends Schema.TaggedErrorClass<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusSelf = typeof TailscaleStatusSelf.Type;
export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export const parseTailscaleMagicDnsName = (
  rawStatusJson: string,
): Effect.Effect<string | null, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map(normalizeMagicDnsName),
  );

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
      };
    }),
  );

const readTailscaleCommandStdout = (input: {
  readonly args: ReadonlyArray<string>;
  readonly subcommand: "status" | "serve";
  readonly timeout: Duration.Duration;
}): Effect.Effect<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { command: executable } = yield* resolveTailscaleExecutable;
    const commandContext = {
      executable,
      subcommand: input.subcommand,
      argumentCount: input.args.length,
    };
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make(executable, input.args))
        .pipe(
          Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStdout(child.stdout),
          collectStderr(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(input.timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(input.timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const readTailscaleStatus = readTailscaleCommandStdout({
  args: ["status", "--json"],
  subcommand: "status",
  timeout: TAILSCALE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleStatus));

/**
 * The HTTPS ports this node's Tailscale Serve config already has web handlers
 * on. Read before configuring serve so a port owned by another service on the
 * machine is never silently taken over — and never torn down on quit.
 */
export const readTailscaleServeConfig: Effect.Effect<
  ReadonlyArray<TailscaleServeMount>,
  TailscaleCommandError | TailscaleServeConfigParseError,
  ChildProcessSpawner.ChildProcessSpawner
> = readTailscaleCommandStdout({
  args: ["serve", "status", "--json"],
  subcommand: "serve",
  timeout: TAILSCALE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleServeConfig));

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

const runTailscaleCommand = (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { command: executable } = yield* resolveTailscaleExecutable;
    const commandContext = {
      executable,
      subcommand: "serve" as const,
      argumentCount: args.length,
    };
    const timeout = Duration.fromInputUnsafe(timeoutInput);
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make(executable, args))
        .pipe(
          Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        );
      const [stderr, exitCode] = yield* Effect.all(
        [collectStderr(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stderrLength: stderr.length,
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const args = ["serve", "--bg", `--https=${servePort}`, `http://${localHost}:${input.localPort}`];
  return runTailscaleCommand(args, TAILSCALE_SERVE_TIMEOUT);
};

export const disableTailscaleServe = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    return yield* runTailscaleCommand(
      ["serve", `--https=${servePort}`, "off"],
      TAILSCALE_SERVE_TIMEOUT,
    );
  });

/**
 * Why a tailnet base URL is not usable as an advertised endpoint. Reported so
 * the failure shows up once, in the server log, instead of as an unexplained
 * HTTP error inside a client's pairing sheet days later.
 */
export type TailscaleServeProbeFailure =
  /** No HTTP response before the timeout. */
  | { readonly reason: "unreachable" }
  /** Something answered, but not with a success status. */
  | { readonly reason: "http-status"; readonly status: number }
  /** Something answered 2xx that is not a SergeCode environment descriptor. */
  | { readonly reason: "not-an-environment"; readonly status: number }
  /** A different SergeCode environment answered on this hostname. */
  | { readonly reason: "environment-mismatch"; readonly environmentId: string };

export type TailscaleServeProbeResult =
  | { readonly ok: true }
  | ({ readonly ok: false } & TailscaleServeProbeFailure);

/**
 * Confirms that a tailnet HTTPS base URL actually reaches *this* server before
 * it is advertised to clients.
 *
 * `tailscale serve` exiting 0 only means the config was accepted; it does not
 * mean the hostname resolves, that the cert is issued, or that the mount was
 * not replaced by another service on the node. Advertising an unverified URL
 * produces pairing links that fail on the far side with whatever happens to be
 * listening — the failure surfaces on the client, far from its cause.
 */
export const probeTailscaleServeEndpoint = (input: {
  readonly baseUrl: string;
  readonly expectedEnvironmentId: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<TailscaleServeProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const probed = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const response = yield* client.execute(HttpClientRequest.get(url.toString()));
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: "http-status", status: response.status } as const;
      }
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      const environmentId =
        typeof body === "object" && body !== null && "environmentId" in body
          ? (body as { readonly environmentId: unknown }).environmentId
          : undefined;
      if (typeof environmentId !== "string" || environmentId.length === 0) {
        return { ok: false, reason: "not-an-environment", status: response.status } as const;
      }
      if (environmentId !== input.expectedEnvironmentId) {
        return { ok: false, reason: "environment-mismatch", environmentId } as const;
      }
      return { ok: true } as const;
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.getOrElse(
      probed,
      () => ({ ok: false, reason: "unreachable" }) as TailscaleServeProbeResult,
    );
  }).pipe(
    // Nothing about a probe may break startup: transport errors and client
    // defects alike collapse to "cannot confirm", which reads as unreachable.
    Effect.orElseSucceed(() => ({ ok: false, reason: "unreachable" }) as const),
    Effect.catchDefect(() => Effect.succeed({ ok: false, reason: "unreachable" } as const)),
  );

export const resolveTailscaleHttpsBaseUrl = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<
  string | null,
  TailscaleCommandError | TailscaleStatusParseError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  readTailscaleStatus.pipe(
    Effect.map((status) =>
      status.magicDnsName
        ? buildTailscaleHttpsBaseUrl({
            magicDnsName: status.magicDnsName,
            ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
          })
        : null,
    ),
  );
