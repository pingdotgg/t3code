import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeHostname } from "@t3tools/shared/hostClassification";
import { SpawnExecutableResolution, type SpawnExecutableResolver } from "@t3tools/shared/shell";
import * as NodeNet from "node:net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
/**
 * Bounds `tailscale status` and `tailscale debug prefs`. Allows the 1.8-2.6 s
 * `tailscale status` has been measured at when T3 Code spawns it on Windows.
 * A CLI that never answers takes longer than this to fail, because the kill
 * that follows the timeout also takes time (`taskkill` on Windows).
 */
const TAILSCALE_STATUS_TIMEOUT = Duration.millis(3_500);
/**
 * How long a probe killed on timeout gets to exit after SIGTERM before its
 * process group is SIGKILLed. Without it the spawner never escalates, so a group
 * member that ignores SIGTERM outlives the call. Short because the timeout error
 * only surfaces once cleanup finishes, and a healthy `tailscale` exits at once.
 */
const TAILSCALE_KILL_GRACE = Duration.millis(500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

/**
 * Where the CLI lives when it is not on PATH. The Mac app's binary must run from
 * inside the bundle; a symlink to it crashes, so it is spawned directly.
 */
const TAILSCALE_INSTALL_LOCATIONS: Partial<Record<NodeJS.Platform, ReadonlyArray<string>>> = {
  darwin: [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
  ],
};

/** PATH first, then the platform's install locations. */
export function findTailscaleExecutable(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly resolve: SpawnExecutableResolver;
}): string {
  const windows = input.platform === "win32";
  const name = windows ? "tailscale.exe" : "tailscale";
  const installed = windows
    ? [`${input.env.ProgramFiles ?? "C:\\Program Files"}\\Tailscale\\tailscale.exe`]
    : (TAILSCALE_INSTALL_LOCATIONS[input.platform] ?? []);
  for (const candidate of [name, ...installed]) {
    const resolved = input.resolve(candidate, input.platform, input.env);
    if (resolved !== undefined) return resolved;
  }
  // Unresolved, the bare name still spawns through PATH and fails as before.
  return name;
}

// Keyed by resolver so a test's resolver never sees another's cached path.
const resolvedTailscaleExecutables = new WeakMap<SpawnExecutableResolver, Map<string, string>>();

const tailscaleExecutable = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const resolve = yield* SpawnExecutableResolution;
  let byPlatform = resolvedTailscaleExecutables.get(resolve);
  if (byPlatform === undefined) {
    byPlatform = new Map();
    resolvedTailscaleExecutables.set(resolve, byPlatform);
  }
  const cached = byPlatform.get(platform);
  if (cached !== undefined) return cached;
  const env = yield* HostProcess.Environment;
  const path = findTailscaleExecutable({ platform, env, resolve });
  byPlatform.set(platform, path);
  return path;
});

const TailscaleCommandContext = {
  executable: Schema.String,
  subcommand: Schema.Literals(["status", "serve", "debug", "whois"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "peer-not-found",
  "not-logged-in",
  "not-running",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/peer not found/i, "peer-not-found"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  // Only answers that confirm no daemon; a dial can also fail for want of permission. Windows
  // reports a missing service as its pipe not being found, without the usual prefix.
  [
    /doesn't appear to be running|tailscaled\.service not running|tailscale is stopped|tailscaled: the system cannot find the file specified|failed to connect to local tailscale[\s\S]*(connection refused|no such file or directory|cannot find the file)/i,
    "not-running",
  ],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

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
  CapMap: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
  /**
   * `tailscale serve --https` needs the `https` capability, which the control
   * plane grants once the tailnet enables HTTPS certificates. `null` when the
   * CLI reports no capability map (older CLI), so callers still attempt serve.
   */
  readonly httpsServeEnabled: boolean | null;
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

      const capMap = parsed.Self?.CapMap;
      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
        httpsServeEnabled:
          typeof capMap === "object" && capMap !== null && !Array.isArray(capMap)
            ? Object.hasOwn(capMap, "https")
            : null,
      };
    }),
  );

const readTailscaleOutput = Effect.fn("tailscale.readTailscaleOutput")(function* (
  subcommand: "status" | "debug" | "serve" | "whois",
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* tailscaleExecutable;
  const commandContext = {
    executable,
    subcommand,
    argumentCount: args.length,
  };
  const command = ChildProcess.make(executable, [...args], {
    forceKillAfter: TAILSCALE_KILL_GRACE,
  });
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(command).pipe(
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
    return stdout;
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

export const readTailscaleStatus = readTailscaleOutput("status", ["status", "--json"]).pipe(
  Effect.flatMap(parseTailscaleStatus),
);

const TailscaleStatusNode = Schema.Struct({
  HostName: Schema.optional(Schema.Unknown),
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
  UserID: Schema.optional(Schema.Unknown),
  Tags: Schema.optional(Schema.Unknown),
  Online: Schema.optional(Schema.Unknown),
  OS: Schema.optional(Schema.Unknown),
  CapMap: Schema.optional(Schema.Unknown),
});

const TailnetStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusNode),
  Peer: Schema.optional(Schema.Record(Schema.String, TailscaleStatusNode)),
});

const decodeTailnetStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailnetStatusJson));

export interface TailnetPeer {
  /** The tailnet machine name (MagicDNS label), falling back to the OS host name. */
  readonly nodeName: string;
  readonly magicDnsName: string | null;
  readonly tailnetAddresses: readonly string[];
  readonly userId: string | null;
  readonly tags: readonly string[];
  readonly online: boolean;
  readonly os: string | null;
}

export interface Tailnet {
  readonly self: {
    readonly userId: string | null;
    readonly magicDnsName: string | null;
    readonly tailnetAddresses: readonly string[];
    readonly httpsServeEnabled: boolean | null;
  };
  readonly peers: readonly TailnetPeer[];
}

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeDnsName = (value: unknown): string | null =>
  nonEmptyString(typeof value === "string" ? value.replace(/\.$/u, "") : value);

// Tailscale user IDs are int64; JSON numbers lose precision past 2^53, so ids stay strings.
const userIdOf = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : nonEmptyString(value);

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** 100.64.0.0/10 or fd7a:115c:a1e0::/48: the only addresses Tailscale assigns to nodes. */
export function isTailnetAddress(address: string): boolean {
  switch (NodeNet.isIP(address)) {
    case 4:
      return isTailscaleIpv4Address(address);
    case 6: {
      const groups = address.toLowerCase().split(":");
      return groups[0] === "fd7a" && groups[1] === "115c" && groups[2] === "a1e0";
    }
    default:
      return false;
  }
}

const parseTailnet = (rawStatusJson: string): Effect.Effect<Tailnet, TailscaleStatusParseError> =>
  decodeTailnetStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const self = parsed.Self;
      const capMap = self?.CapMap;
      return {
        self: {
          userId: userIdOf(self?.UserID),
          magicDnsName: normalizeDnsName(self?.DNSName),
          tailnetAddresses: stringsOf(self?.TailscaleIPs).filter(isTailnetAddress),
          httpsServeEnabled: Predicate.isObject(capMap) ? Object.hasOwn(capMap, "https") : null,
        },
        peers: Object.values(parsed.Peer ?? {}).flatMap((peer) => {
          const magicDnsName = normalizeDnsName(peer.DNSName);
          const nodeName =
            nonEmptyString(magicDnsName?.split(".")[0]) ?? nonEmptyString(peer.HostName);
          if (nodeName === null) return [];
          return [
            {
              nodeName,
              magicDnsName,
              tailnetAddresses: stringsOf(peer.TailscaleIPs).filter(isTailnetAddress),
              userId: userIdOf(peer.UserID),
              tags: stringsOf(peer.Tags),
              online: peer.Online === true,
              os: nonEmptyString(peer.OS),
            },
          ];
        }),
      };
    }),
  );

export const readTailnet = readTailscaleOutput("status", ["status", "--json"]).pipe(
  Effect.flatMap(parseTailnet),
);

const TailscaleWhoisJson = Schema.Struct({
  Node: Schema.optional(
    Schema.Struct({
      Name: Schema.optional(Schema.Unknown),
      ComputedName: Schema.optional(Schema.Unknown),
      Tags: Schema.optional(Schema.Unknown),
    }),
  ),
  UserProfile: Schema.optional(
    Schema.Struct({
      ID: Schema.optional(Schema.Unknown),
      LoginName: Schema.optional(Schema.Unknown),
    }),
  ),
  CapMap: Schema.optional(Schema.Unknown),
});

const decodeTailscaleWhoisJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleWhoisJson));

export interface TailnetWhois {
  readonly userId: string | null;
  readonly loginName: string | null;
  /** The tailnet machine name (MagicDNS label). */
  readonly nodeName: string;
  readonly tags: readonly string[];
  /** Peer capabilities the tailnet policy grants this node, such as `example.com/cap/x`. */
  readonly capabilities: readonly string[];
}

export const parseTailscaleWhois = (
  rawWhoisJson: string,
): Effect.Effect<TailnetWhois | null, TailscaleStatusParseError> =>
  decodeTailscaleWhoisJson(rawWhoisJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const nodeName =
        nonEmptyString(normalizeDnsName(parsed.Node?.Name)?.split(".")[0]) ??
        nonEmptyString(parsed.Node?.ComputedName);
      if (nodeName === null) return null;
      return {
        userId: userIdOf(parsed.UserProfile?.ID),
        loginName: nonEmptyString(parsed.UserProfile?.LoginName),
        nodeName,
        tags: stringsOf(parsed.Node?.Tags),
        capabilities: Predicate.isObject(parsed.CapMap) ? Object.keys(parsed.CapMap) : [],
      };
    }),
  );

/** Who owns a tailnet address. `null` for addresses outside the tailnet or unknown to it. */
export const whoisTailnetAddress = Effect.fn("tailscale.whoisTailnetAddress")(function* (
  address: string,
) {
  // `tailscale whois` also accepts names, but answers them with an HTTP 400.
  if (!isTailnetAddress(address)) return null;
  return yield* readTailscaleOutput("whois", ["whois", "--json", address]).pipe(
    Effect.flatMap(parseTailscaleWhois),
    Effect.catchIf(
      (error) =>
        error._tag === "TailscaleCommandExitError" && error.stderrDiagnostic === "peer-not-found",
      () => Effect.succeed(null),
    ),
  );
});

const TailscaleExitNodeJson = Schema.Struct({
  ExitNodeStatus: Schema.optional(Schema.Struct({ Online: Schema.optional(Schema.Unknown) })),
  Peer: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        ExitNode: Schema.optional(Schema.Unknown),
        HostName: Schema.optional(Schema.Unknown),
        DNSName: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
});

const decodeTailscaleExitNodeJson = Schema.decodeEffect(
  Schema.fromJsonString(TailscaleExitNodeJson),
);

export interface TailscaleExitNode {
  readonly name: string | null;
  readonly online: boolean;
}

/**
 * `ExitNodeStatus` is present only while an exit node is in use, but it has no
 * name. The name comes from the peer marked `ExitNode: true`.
 */
export const parseTailscaleExitNode = (
  rawStatusJson: string,
): Effect.Effect<TailscaleExitNode | null, TailscaleStatusParseError> =>
  decodeTailscaleExitNodeJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      if (parsed.ExitNodeStatus === undefined) return null;
      const peer = Object.values(parsed.Peer ?? {}).find(
        (candidate) => candidate.ExitNode === true,
      );
      // The DNS label is the tailnet machine name; HostName is the OS name and ignores renames.
      const dnsLabel = typeof peer?.DNSName === "string" ? (peer.DNSName.split(".")[0] ?? "") : "";
      const hostName = typeof peer?.HostName === "string" ? peer.HostName.trim() : "";
      return {
        name: dnsLabel || hostName || null,
        online: parsed.ExitNodeStatus.Online === true,
      };
    }),
  );

export const readTailscaleExitNode = readTailscaleOutput("status", ["status", "--json"]).pipe(
  Effect.flatMap(parseTailscaleExitNode),
);

const TailscalePrefsJson = Schema.Struct({
  RunSSH: Schema.optional(Schema.Unknown),
  WantRunning: Schema.optional(Schema.Unknown),
});

const decodeTailscalePrefsJson = Schema.decodeEffect(Schema.fromJsonString(TailscalePrefsJson));

/**
 * `tailscale status --json` does not report this for the local node. `tailscale
 * down` clears WantRunning but keeps RunSSH, so check both.
 */
export const parseTailscaleSshEnabled = (
  rawPrefsJson: string,
): Effect.Effect<boolean, TailscaleStatusParseError> =>
  decodeTailscalePrefsJson(rawPrefsJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((prefs) => prefs.RunSSH === true && prefs.WantRunning !== false),
  );

export const readTailscaleSshEnabled = readTailscaleOutput("debug", ["debug", "prefs"]).pipe(
  Effect.flatMap(parseTailscaleSshEnabled),
);

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

const runTailscaleCommand = Effect.fn("tailscale.runTailscaleCommand")(function* (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.fn.Return<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* tailscaleExecutable;
  const commandContext = {
    executable,
    subcommand: "serve" as const,
    argumentCount: args.length,
  };
  const timeout = Duration.fromInputUnsafe(timeoutInput);
  return yield* Effect.gen(function* () {
    const child = yield* spawner
      .spawn(ChildProcess.make(executable, args, { forceKillAfter: TAILSCALE_KILL_GRACE }))
      .pipe(
        Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
        ),
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
        ...(stderrDiagnosticOf(stderr) !== undefined
          ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
          : {}),
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

/** A Serve route: a web handler at `mount` on `servePort`, or a TCP forward without one. */
export interface TailscaleServeRoute {
  readonly servePort: number;
  readonly mount?: string;
  /** The machine name a web route serves under. */
  readonly host?: string;
  /** A target, such as a name, that may dial this server or another service on the same port. */
  readonly ambiguous?: string;
  /** The Tailscale Service it belongs to, or `foreground` for a `tailscale serve` still running. */
  readonly owner?: string;
}

/**
 * The `tailscale` arguments that turn `route` off; a foreground route has none, since it ends with
 * its command. A web route names its path: without one the CLI removes every handler on the port,
 * and answers its own confirmation prompt with yes when nobody is there to answer.
 */
export const tailscaleServeOffArgs = (
  route: TailscaleServeRoute,
): ReadonlyArray<string> | undefined =>
  route.owner === "foreground"
    ? undefined
    : [
        "serve",
        ...(route.owner === undefined ? [] : [`--service=${route.owner}`]),
        ...(route.mount === undefined
          ? [`--tcp=${route.servePort}`]
          : [`--https=${route.servePort}`, `--set-path=${route.mount}`]),
        "off",
      ];

/** Removes the web handler at `mount` on `servePort`, the root one `ensureTailscaleServe` adds by default. */
export const disableTailscaleServe = Effect.fn("tailscale.disableTailscaleServe")(function* (
  input: {
    readonly servePort?: number;
    readonly mount?: string;
  } = {},
): Effect.fn.Return<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  return yield* runTailscaleCommand(
    tailscaleServeOffArgs({
      servePort: input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      mount: input.mount ?? "/",
    })!,
    TAILSCALE_SERVE_TIMEOUT,
  );
});

/** Removes a TCP forward on `servePort`; one port holds one forward, so nothing else goes. */
export const disableTailscaleServeTcp = (servePort: number) =>
  runTailscaleCommand(tailscaleServeOffArgs({ servePort })!, TAILSCALE_SERVE_TIMEOUT);

const TailscaleServeConfigJson = Schema.Struct({
  TCP: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ TCPForward: Schema.optional(Schema.String) })),
  ),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.optional(
          Schema.Record(Schema.String, Schema.Struct({ Proxy: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});
const TailscaleServeStatusJson = Schema.Struct({
  ...TailscaleServeConfigJson.fields,
  // A Tailscale Service's routes, and those of each `tailscale serve` still running in the foreground.
  Services: Schema.optional(Schema.Record(Schema.String, TailscaleServeConfigJson)),
  Foreground: Schema.optional(Schema.Record(Schema.String, TailscaleServeConfigJson)),
});
// A node without any Serve configuration prints `null`.
const decodeTailscaleServeStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(TailscaleServeStatusJson)),
);

/**
 * Whether a proxy to `hostname` dials `bindHost`. `0.0.0.0` reaches 127.0.0.1. `[::]` may reach
 * either loopback, since Go dials `::` and then 0.0.0.0 (golang/go#18806), and a name such as
 * `localhost` may resolve to whatever the server binds.
 */
const reaches = (hostname: string, bindHost: string): "exact" | "either" | undefined => {
  let address = normalizeHostname(hostname);
  // Compare IPv6 by value: 0:0:0:0:0:ffff:7f00:1 is ::ffff:7f00:1.
  if (address.includes(":") && URL.canParse(`http://[${address}]`)) {
    address = normalizeHostname(new URL(`http://[${address}]`).hostname);
  }
  // An IPv4-mapped address can be written as hex, such as ::ffff:7f00:1 for 127.0.0.1.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    address = [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
  } else if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  // Strict, as Go's ParseIP is; anything else, such as `127.1` or `box.1`, goes to the resolver.
  const literal =
    address.includes(":") ||
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?!$)|$)){4}$/u.test(address);
  if (!literal) return "either";
  if (address === "::")
    return bindHost === "127.0.0.1" || bindHost === "::1" ? "either" : undefined;
  return (address === "0.0.0.0" ? "127.0.0.1" : address) === bindHost ? "exact" : undefined;
};

/** The URL Tailscale's proxy dials for a handler's `Proxy`, expanded as its `expandProxyArg` does. */
const expandProxy = (proxy: string) =>
  /^\d+$/u.test(proxy)
    ? `http://127.0.0.1:${proxy}`
    : proxy.startsWith("https+insecure://")
      ? `https://${proxy.slice("https+insecure://".length)}`
      : /^(?:https?:\/\/|unix:)/u.test(proxy)
        ? proxy
        : `http://${proxy}`;

/**
 * The host and port a proxy target dials, read as Go's url.Parse reads it rather than as a WHATWG
 * URL, which rejects `box.1` and rewrites `127.1`; none for a Unix socket.
 */
const dialedHostPort = (url: string) => {
  const match = /^(https?|tcp):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d*))?/iu.exec(url);
  if (match === null) return undefined;
  const [, scheme = "", host = "", port] = match;
  return { host, port: port || (scheme.toLowerCase() === "https" ? "443" : "80") };
};

const reachesTarget = (url: string, target: { readonly host: string; readonly port: number }) => {
  const dialed = dialedHostPort(url);
  // Go reads the port as a decimal number, so 03773 is 3773.
  if (dialed === undefined || Number(dialed.port) !== target.port) return undefined;
  const reach = reaches(dialed.host, target.host);
  return reach === undefined ? undefined : { reach, hostname: dialed.host };
};

/**
 * The Serve routes that forward to the server bound at `target`, or undefined when the status
 * cannot be read.
 */
export const parseTailscaleServeRoutesTo = (
  rawServeStatusJson: string,
  target: { readonly host: string; readonly port: number },
): ReadonlyArray<TailscaleServeRoute> | undefined => {
  const status = decodeTailscaleServeStatusJson(rawServeStatusJson);
  if (Option.isNone(status)) return undefined;
  const routesIn = (
    config: typeof TailscaleServeConfigJson.Type | undefined,
    owner?: string,
  ): ReadonlyArray<TailscaleServeRoute> => {
    const scope = owner === undefined ? {} : { owner };
    const reached = (url: string) => {
      const found = reachesTarget(url, target);
      if (found === undefined) return undefined;
      return found.reach === "either" ? { ambiguous: found.hostname } : {};
    };
    const tcp = Object.entries(config?.TCP ?? {}).flatMap(([port, handler]) => {
      const reach =
        handler.TCPForward === undefined || handler.TCPForward.startsWith("unix:")
          ? undefined
          : reached(`tcp://${handler.TCPForward}`);
      return reach !== undefined && Number.isInteger(Number(port))
        ? [{ servePort: Number(port), ...reach, ...scope }]
        : [];
    });
    const web = Object.entries(config?.Web ?? {}).flatMap(([hostPort, site]) => {
      const separator = hostPort.lastIndexOf(":");
      const servePort = Number(hostPort.slice(separator + 1));
      if (!Number.isInteger(servePort)) return [];
      const host = hostPort.slice(0, separator);
      return Object.entries(site.Handlers ?? {}).flatMap(([mount, handler]) => {
        const reach = handler.Proxy === undefined ? undefined : reached(expandProxy(handler.Proxy));
        return reach === undefined ? [] : [{ servePort, mount, host, ...reach, ...scope }];
      });
    });
    return [...tcp, ...web];
  };
  return [
    ...routesIn(status.value ?? undefined),
    ...Object.entries(status.value?.Services ?? {}).flatMap(([name, service]) =>
      routesIn(service, name),
    ),
    ...Object.values(status.value?.Foreground ?? {}).flatMap((session) =>
      routesIn(session, "foreground"),
    ),
  ];
};

/** The Serve routes that forward to the server bound at `target` on this machine. */
export const readTailscaleServeRoutesTo = (target: {
  readonly host: string;
  readonly port: number;
}) =>
  readTailscaleOutput("serve", ["serve", "status", "--json"]).pipe(
    Effect.flatMap((status) => {
      const routes = parseTailscaleServeRoutesTo(status, target);
      return routes === undefined
        ? Effect.fail(new TailscaleStatusParseError({ cause: "unreadable serve status" }))
        : Effect.succeed(routes);
    }),
  );

export const probeTailscaleHttpsEndpoint = Effect.fn("tailscale.probeTailscaleHttpsEndpoint")(
  function* (input: { readonly baseUrl: string; readonly timeout?: Duration.Input }) {
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
  },
  Effect.orElseSucceed(() => false),
);

const decodeTailscaleServeHandlersJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TailscaleServeStatusJson),
);

/** What one tailnet port forwards to: an `http://` proxy target or a `tcp://` forward. */
export interface TailscaleServeHandler {
  readonly servePort: number;
  readonly target: string;
}

export const parseTailscaleServeHandlers = (
  rawServeStatusJson: string,
): Effect.Effect<ReadonlyArray<TailscaleServeHandler>, TailscaleStatusParseError> =>
  decodeTailscaleServeHandlersJson(rawServeStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const handlers = new Map<number, string>();
      for (const [hostPort, site] of Object.entries(parsed.Web ?? {})) {
        const servePort = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
        const proxies = Object.entries(site.Handlers ?? {}).flatMap(([path, handler]) =>
          handler.Proxy === undefined ? [] : [[path, handler.Proxy] as const],
        );
        const target = (proxies.find(([path]) => path === "/") ?? proxies[0])?.[1];
        if (Number.isInteger(servePort) && target !== undefined) handlers.set(servePort, target);
      }
      for (const [port, forward] of Object.entries(parsed.TCP ?? {})) {
        if (forward.TCPForward !== undefined && !handlers.has(Number(port))) {
          handlers.set(Number(port), `tcp://${forward.TCPForward}`);
        }
      }
      return Array.from(handlers, ([servePort, target]) => ({ servePort, target }));
    }),
  );

export const readTailscaleServeHandlers = readTailscaleOutput("serve", [
  "serve",
  "status",
  "--json",
]).pipe(Effect.flatMap(parseTailscaleServeHandlers));

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Loopback aliases count as one host: tailscale reaches a dual-stack listener through any of them. */
export function isServeTargetFor(
  target: string,
  local: { readonly localPort: number; readonly localHost?: string },
): boolean {
  const url = URL.parse(target);
  if (url === null || url.protocol !== "http:" || Number(url.port) !== local.localPort) {
    return false;
  }
  const localHost = local.localHost ?? "127.0.0.1";
  return (
    url.hostname === localHost ||
    (LOOPBACK_HOSTS.has(url.hostname) && LOOPBACK_HOSTS.has(localHost))
  );
}

/**
 * Whether anything answers at a mapping's target. Any HTTP status counts: only a refused or
 * silent target is stale. A raw TCP forward cannot be probed this way, so it counts as live.
 */
const isServeTargetLive = (target: string) =>
  target.startsWith("tcp://")
    ? Effect.succeed(true)
    : Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get(target)).pipe(
          Effect.scoped,
          Effect.timeoutOption(TAILSCALE_PROBE_TIMEOUT),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        );
      });

/** Only a free, dead-target or already-owned port may change; another live server must stay reachable. */
export type TailscaleServePortOwnership =
  | { readonly _tag: "free" }
  | { readonly _tag: "ours"; readonly target: string }
  | { readonly _tag: "stale"; readonly target: string }
  | { readonly _tag: "taken"; readonly target: string };

const servePortOwnership = Effect.fn("tailscale.servePortOwnership")(function* (
  handlers: ReadonlyArray<TailscaleServeHandler>,
  servePort: number,
  local: { readonly localPort: number; readonly localHost?: string },
) {
  const existing = handlers.find((handler) => handler.servePort === servePort);
  if (existing === undefined) return { _tag: "free" } as TailscaleServePortOwnership;
  const { target } = existing;
  if (isServeTargetFor(target, local)) return { _tag: "ours", target } as const;
  return (yield* isServeTargetLive(target))
    ? ({ _tag: "taken", target } as const)
    : ({ _tag: "stale", target } as const);
});

export const inspectTailscaleServePort = Effect.fn("tailscale.inspectTailscaleServePort")(
  function* (input: {
    readonly localPort: number;
    readonly servePort?: number;
    readonly localHost?: string;
  }) {
    const handlers = yield* readTailscaleServeHandlers;
    return yield* servePortOwnership(
      handlers,
      input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      input,
    );
  },
);

/** Serve accepts any port; only Funnel is limited to 443, 8443 and 10000. */
const TAILSCALE_SERVE_FALLBACK_PORTS = [443, 8443] as const;
const TAILSCALE_SERVE_SCAN_START = 3443;
const MAX_PORT = 65_535;

/** Ports to try in order: the caller's preferences (such as the last port used), 443, 8443, then 3443 upward. */
export function* tailscaleServePortCandidates(
  preferred: ReadonlyArray<number> = [],
): Generator<number> {
  const seen = new Set<number>();
  for (const port of [...preferred, ...TAILSCALE_SERVE_FALLBACK_PORTS]) {
    if (Number.isInteger(port) && port > 0 && port <= MAX_PORT && !seen.has(port)) {
      seen.add(port);
      yield port;
    }
  }
  for (let port = TAILSCALE_SERVE_SCAN_START; port <= MAX_PORT; port += 1) {
    if (!seen.has(port)) yield port;
  }
}

export class TailscaleServePortExhaustedError extends Schema.TaggedError<TailscaleServePortExhaustedError>()(
  "TailscaleServePortExhaustedError",
  {},
) {
  override get message(): string {
    return "Every Tailscale Serve port already forwards to another live server.";
  }
}

/**
 * The first port in `tailscaleServePortCandidates` this server may publish on: one
 * already forwarding here, free, or forwarding to a dead target. Ports serving another
 * live server are skipped so it stays reachable.
 */
export const selectTailscaleServePort = Effect.fn("tailscale.selectTailscaleServePort")(
  function* (input: {
    readonly localPort: number;
    readonly localHost?: string;
    readonly preferredPorts?: ReadonlyArray<number>;
  }) {
    const handlers = yield* readTailscaleServeHandlers;
    for (const servePort of tailscaleServePortCandidates(input.preferredPorts)) {
      const ownership = yield* servePortOwnership(handlers, servePort, input);
      if (ownership._tag !== "taken") return { servePort, ownership };
    }
    return yield* new TailscaleServePortExhaustedError();
  },
);

/** The tailnet port whose Serve mapping forwards to this local server, if any. */
export const findTailscaleServePortFor = Effect.fn("tailscale.findTailscaleServePortFor")(
  function* (local: { readonly localPort: number; readonly localHost?: string }) {
    const handlers = yield* readTailscaleServeHandlers;
    return (
      handlers
        .filter((handler) => isServeTargetFor(handler.target, local))
        .map((handler) => handler.servePort)
        .toSorted((left, right) => left - right)[0] ?? null
    );
  },
);
