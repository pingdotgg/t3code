import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

// tailscale is a real executable everywhere (`tailscale.exe` on Windows), so
// it is always spawned directly rather than through cmd.exe shell mode.
const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe"]),
  subcommand: Schema.Literals(["status", "serve"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedError<TailscaleCommandSpawnError>()(
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

class TailscaleCommandOutputError extends Schema.TaggedError<TailscaleCommandOutputError>()(
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

export class TailscaleCommandExitError extends Schema.TaggedError<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedError<TailscaleCommandTimeoutError>()(
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

export type TailscaleCommandError =
  | TailscaleCommandSpawnError
  | TailscaleCommandOutputError
  | TailscaleCommandExitError
  | TailscaleCommandTimeoutError;

export class TailscaleStatusParseError extends Schema.TaggedError<TailscaleStatusParseError>()(
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

export class TailscaleServeStatusParseError extends Schema.TaggedError<TailscaleServeStatusParseError>()(
  "TailscaleServeStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale serve status JSON.";
  }
}

export class TailscaleServePortOccupiedError extends Schema.TaggedError<TailscaleServePortOccupiedError>()(
  "TailscaleServePortOccupiedError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve HTTPS port ${this.servePort} already has another handler. Choose another Serve port.`;
  }
}

const ServeConfigFields = {
  TCP: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        HTTPS: Schema.optional(Schema.Boolean),
        HTTP: Schema.optional(Schema.Boolean),
        TCPForward: Schema.optional(Schema.String),
        TerminateTLS: Schema.optional(Schema.String),
        ProxyProtocol: Schema.optional(Schema.Number),
      }),
    ),
  ),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.Record(
          Schema.String,
          Schema.Struct({
            Proxy: Schema.optional(Schema.String),
            Path: Schema.optional(Schema.String),
            Text: Schema.optional(Schema.String),
            AcceptAppCaps: Schema.optional(Schema.Array(Schema.String)),
            Redirect: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
  AllowFunnel: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  // Services use separate addresses; node-port Serve commands do not change them.
  Services: Schema.optional(Schema.Unknown),
};
const ServeConfig = Schema.Struct(ServeConfigFields);
const ServeStatus = Schema.NullOr(
  Schema.Struct({
    ...ServeConfigFields,
    Foreground: Schema.optional(Schema.Record(Schema.String, ServeConfig)),
  }),
);

// Reachability does not establish ownership: a DNS failure or a stopped
// backend can hide a foreign mapping. Inspect the selected port's config.
function servePortState(status: typeof ServeStatus.Type, servePort: number, target: string) {
  const port = String(servePort);
  const onPort = (authority: string) => authority.endsWith(`:${port}`);
  const hasPort = (config: typeof ServeConfig.Type) =>
    config.TCP?.[port] !== undefined ||
    Object.keys(config.Web ?? {}).some(onPort) ||
    Object.keys(config.AllowFunnel ?? {}).some(onPort);
  if (status === null) return "empty";
  if (Object.values(status.Foreground ?? {}).some(hasPort)) return "occupied";
  if (
    Object.entries(status.AllowFunnel ?? {}).some(
      ([authority, allowed]) => onPort(authority) && allowed,
    )
  )
    return "occupied";
  const tcp = status.TCP?.[port];
  const web = Object.entries(status.Web ?? {}).filter(([authority]) => onPort(authority));
  if (tcp === undefined && web.length === 0) return "empty";
  if (
    tcp?.HTTPS !== true ||
    tcp.HTTP === true ||
    tcp.TCPForward ||
    tcp.TerminateTLS ||
    (tcp.ProxyProtocol ?? 0) !== 0 ||
    web.length !== 1
  )
    return "occupied";
  const handlers = web[0]?.[1].Handlers;
  const root = handlers?.["/"];
  if (
    handlers === undefined ||
    Object.keys(handlers).length !== 1 ||
    root?.Proxy === undefined ||
    root.Path ||
    root.Text ||
    root.Redirect ||
    (root.AcceptAppCaps?.length ?? 0) > 0
  )
    return "occupied";
  return root.Proxy.replace(/\/$/u, "") === target ? "matching" : "replaceable";
}

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

export const readTailscaleStatus = Effect.gen(function* () {
  const args = ["status", "--json"];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcess.Platform;
  const executable = tailscaleCommandForPlatform(hostPlatform);
  const commandContext = {
    executable,
    subcommand: "status" as const,
    argumentCount: args.length,
  };
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(executable, args)).pipe(
      Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
      // Spawning can also fail as a defect rather than a typed error - a
      // non-directory entry on PATH makes node throw ENOTDIR synchronously.
      // `mapError` never sees that, so it would escape as an uncaught error.
      Effect.catchDefect((cause) =>
        Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
      ),
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
        ...(stderrDiagnosticOf(stderr) !== undefined
          ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
          : {}),
      });
    }
    return yield* parseTailscaleStatus(stdout);
  }).pipe(
    Effect.scoped,
    Effect.timeout(TAILSCALE_STATUS_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new TailscaleCommandTimeoutError({
            ...commandContext,
            timeoutMs: Duration.toMillis(TAILSCALE_STATUS_TIMEOUT),
            cause,
          }),
        ),
    }),
  );
});

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
): Effect.Effect<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcess.Platform;
    const executable = tailscaleCommandForPlatform(hostPlatform);
    const commandContext = {
      executable,
      subcommand: "serve" as const,
      argumentCount: args.length,
    };
    const timeout = Duration.fromInputUnsafe(timeoutInput);
    return yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(executable, args)).pipe(
        Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
        ),
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
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
      return stdout;
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

const readServeStatus = runTailscaleCommand(
  ["serve", "status", "--json"],
  TAILSCALE_STATUS_TIMEOUT,
).pipe(
  // Dropping unknown fields could make a customized handler look safe to remove.
  Effect.flatMap(
    Schema.decodeEffect(Schema.fromJsonString(ServeStatus), { onExcessProperty: "error" }),
  ),
  Effect.catchTags({
    SchemaError: (cause) => Effect.fail(new TailscaleServeStatusParseError({ cause })),
  }),
);

export const ensureTailscaleServe = Effect.fnUntraced(function* (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
  // Only pairing may set this, after the old handler answers with the same
  // environment id. It never permits replacing complex or public handlers.
  readonly replaceVerifiedHandler?: boolean;
}) {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const target = `http://${localHost}:${input.localPort}`;
  const state = servePortState(yield* readServeStatus, servePort, target);
  if (state === "matching") return;
  if (state === "occupied" || (state === "replaceable" && !input.replaceVerifiedHandler)) {
    return yield* new TailscaleServePortOccupiedError({ servePort });
  }
  yield* runTailscaleCommand(
    ["serve", "--bg", `--https=${servePort}`, target],
    TAILSCALE_SERVE_TIMEOUT,
  );
});

/** Returns whether the selected port is clear; leaves nonmatching handlers alone. */
export const disableTailscaleServe = Effect.fnUntraced(function* (input: {
  readonly localPort: number;
  readonly localHost?: string;
  readonly servePort?: number;
}) {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const target = `http://${input.localHost ?? "127.0.0.1"}:${input.localPort}`;
  const state = servePortState(yield* readServeStatus, servePort, target);
  if (state === "empty") return true;
  if (state !== "matching") return false;
  yield* runTailscaleCommand(["serve", `--https=${servePort}`, "off"], TAILSCALE_SERVE_TIMEOUT);
  return true;
});

export const probeTailscaleHttpsEndpoint = (input: {
  readonly baseUrl: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const request = HttpClientRequest.get(url.toString());
      return yield* client.execute(request);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.match(response, {
      onNone: () => false,
      onSome: (httpResponse) => httpResponse.status >= 200 && httpResponse.status < 300,
    });
  }).pipe(Effect.orElseSucceed(() => false));
