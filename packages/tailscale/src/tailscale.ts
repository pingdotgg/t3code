import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
export const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
export const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

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
  "serve-not-enabled",
  "no-https-certs",
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
  [/serve is not enabled on your tailnet/i, "serve-not-enabled"],
  [/does not support getting TLS certs/i, "no-https-certs"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
export const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
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
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
    /**
     * Admin URL the CLI prints when the tailnet blocks Serve/HTTPS.
     *
     * Exempt from the label-only rule above because it is not lifted text.
     * {@link extractTailscaleServeConfigureUrl} does not return what it matched
     * — it rebuilds the URL from a literal origin and path, keeping only an
     * allowlisted `node` parameter of known shape — so no part of it can carry
     * stderr contents. Without it there is no way to point the user at the one
     * page that fixes the failure.
     */
    configureUrl: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return formatTailscaleCommandExitMessage({
      subcommand: this.subcommand,
      exitCode: this.exitCode,
      stderrDiagnostic: this.stderrDiagnostic,
      configureUrl: this.configureUrl,
    });
  }
}

/** Admin console URL Tailscale prints when Serve/HTTPS is not enabled for the tailnet. */
const TAILSCALE_SERVE_CONFIGURE_URL_PATTERN =
  /https:\/\/login\.tailscale\.com\/f\/serve\?[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/i;

/** Canonical origin and path this helper is willing to emit. */
const TAILSCALE_SERVE_CONFIGURE_URL_BASE = "https://login.tailscale.com/f/serve";

/**
 * Stable node ID shape, used to vet the one query parameter we keep.
 *
 * Tailscale's stable IDs are short and alphanumeric (`nExampleNodeId`); a value
 * that does not look like one is not a node ID, so dropping it costs nothing.
 */
const TAILSCALE_NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Extract a Tailscale Serve enablement URL from CLI text.
 * Only accepts `https://login.tailscale.com/f/serve...` URLs.
 *
 * Returns a URL *rebuilt* from constants rather than the matched text. Checking
 * the parsed origin and path is not enough on its own: the match runs to the
 * end of the URL token, so the query would arrive verbatim from stderr — and
 * this value reaches `TailscaleCommandExitError.message`, which is logged. That
 * is exactly the leak `stderrDiagnostic` exists to prevent, so the query is
 * rebuilt from an allowlist instead of being trusted. The CLI emits `?node=` to
 * preselect the node in the admin console; anything else is dropped, at worst
 * costing that preselection while still landing on the page that fixes the
 * failure.
 */
export function extractTailscaleServeConfigureUrl(text: string): string | null {
  const match = text.match(TAILSCALE_SERVE_CONFIGURE_URL_PATTERN);
  if (!match?.[0] || match[0].length > 500) {
    return null;
  }

  try {
    const parsed = new URL(match[0]);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "login.tailscale.com") return null;
    if (!parsed.pathname.startsWith("/f/serve")) return null;

    const sanitized = new URL(TAILSCALE_SERVE_CONFIGURE_URL_BASE);
    const node = parsed.searchParams.get("node");
    if (node !== null && TAILSCALE_NODE_ID_PATTERN.test(node)) {
      sanitized.searchParams.set("node", node);
    }
    return sanitized.toString();
  } catch {
    return null;
  }
}

/**
 * Prose for a classified diagnostic.
 *
 * The label is the safe thing to log; this turns it into something worth
 * showing a user. `unknown` deliberately has no prose — inventing one would
 * imply we recognized a failure we did not.
 */
export function describeTailscaleStderrDiagnostic(
  diagnostic: TailscaleStderrDiagnostic,
): string | null {
  switch (diagnostic) {
    case "no-existing-handler":
      return "No matching Tailscale Serve handler exists.";
    case "not-logged-in":
      return "Tailscale is not logged in.";
    case "permission-denied":
      return "Tailscale denied permission for this command.";
    case "serve-not-enabled":
      return "Serve is not enabled on your tailnet.";
    case "no-https-certs":
      return "This Tailscale account does not support getting TLS certificates required for HTTPS Serve.";
    case "unknown":
      return null;
  }
}

export function formatTailscaleCommandExitMessage(input: {
  readonly subcommand: "status" | "serve";
  readonly exitCode: number;
  readonly stderrDiagnostic?: TailscaleStderrDiagnostic | undefined;
  readonly configureUrl?: string | undefined;
}): string {
  // Stays generic on purpose: this message is logged, and #4556 keeps logs to
  // the label alone. Prose for the label belongs at the UI edge, via
  // describeTailscaleStderrDiagnostic. The admin URL is appended because it is
  // validated rather than lifted, and it is the one actionable thing here.
  const base = `tailscale ${input.subcommand} exited with code ${input.exitCode}.`;
  return input.configureUrl ? `${base} To enable, visit: ${input.configureUrl}` : base;
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

/** User-facing message for any Tailscale CLI failure while configuring Serve. */
export function formatTailscaleServeUserMessage(error: TailscaleCommandError): string {
  switch (error._tag) {
    case "TailscaleCommandSpawnError":
      return "Could not run the tailscale CLI. Is Tailscale installed and on PATH?";
    case "TailscaleCommandOutputError":
      return "Could not read output from the tailscale CLI.";
    case "TailscaleCommandTimeoutError":
      return "The tailscale CLI timed out while configuring Serve.";
    case "TailscaleCommandExitError":
      return error.message;
  }
}

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

export const readTailscaleStatus = Effect.gen(function* () {
  const args = ["status", "--json"];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const executable = tailscaleCommandForPlatform(hostPlatform);
  const commandContext = {
    executable,
    subcommand: "status" as const,
    argumentCount: args.length,
  };
  return yield* Effect.gen(function* () {
    const child = yield* spawner
      .spawn(ChildProcess.make(executable, args))
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
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const executable = tailscaleCommandForPlatform(hostPlatform);
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
        const stderrDiagnostic = stderrDiagnosticOf(stderr);
        const configureUrl = extractTailscaleServeConfigureUrl(stderr);
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stderrLength: stderr.length,
          ...(stderrDiagnostic === undefined ? {} : { stderrDiagnostic }),
          ...(configureUrl === null ? {} : { configureUrl }),
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
