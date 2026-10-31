import * as NodeNet from "node:net";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { isSharedAddressSpaceHost } from "@t3tools/shared/hostClassification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
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
 * macOS GUI apps start with a minimal PATH, and the App Store build ships its
 * CLI only inside the app bundle. Tailscale documents aliasing the bundle
 * binary as `tailscale`.
 */
const DARWIN_CLI_PATHS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
const DARWIN_APP_BUNDLE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * Passive reads run without the user turning on a Tailscale feature or
 * command, so they never spawn the macOS app bundle: that can raise a
 * data-access prompt.
 */
export type TailscaleCliUse = "passive" | "active";

const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe"]),
  subcommand: Schema.Literals(["status", "serve", "debug", "whois"]),
  argumentCount: Schema.Number,
};

type TailscaleSubcommand = typeof TailscaleCommandContext.subcommand.Type;

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

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
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

export class TailscaleWhoisParseError extends Schema.TaggedError<TailscaleWhoisParseError>()(
  "TailscaleWhoisParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale whois JSON.";
  }
}

/** Another server or app holds the Serve port, so T3 Code leaves it alone. */
export class TailscaleServeOccupiedError extends Schema.TaggedError<TailscaleServeOccupiedError>()(
  "TailscaleServeOccupiedError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve HTTPS port ${this.servePort} is in use by another server; leaving it in place.`;
  }
}

/** Go omits empty fields, and one field of an unexpected type must not hide the rest. */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(
    Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeedSome(undefined))),
  );

// Tailscale user IDs are int64; keep the digits so IDs past 2^53 still compare exactly.
const TAILSCALE_INT64_KEYS = new Set(["UserID", "User", "Sharer", "AltSharerUserID", "ID"]);

const parseTailscaleJson = (raw: string): unknown =>
  JSON.parse(raw, (key, value: unknown, context?: { readonly source?: string }) =>
    typeof value === "number" && TAILSCALE_INT64_KEYS.has(key)
      ? (context?.source ?? (Number.isSafeInteger(value) ? String(value) : undefined))
      : value,
  );

const decodeTailscaleJson = <S extends Schema.Top & { readonly DecodingServices: never }, E>(
  schema: S,
  onError: (cause: unknown) => E,
) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (raw: string): Effect.Effect<S["Type"], E> =>
    Effect.try({ try: () => parseTailscaleJson(raw), catch: onError }).pipe(
      Effect.flatMap((json) => decode(json).pipe(Effect.mapError(onError))),
    );
};

const TailscaleStatusNodeFields = {
  ID: lenient(Schema.String),
  HostName: lenient(Schema.String),
  DNSName: lenient(Schema.String),
  OS: lenient(Schema.String),
  UserID: lenient(Schema.String),
  TailscaleIPs: lenient(Schema.Array(Schema.String)),
  Tags: lenient(Schema.Array(Schema.String)),
  KeyExpiry: lenient(Schema.String),
  Expired: lenient(Schema.Boolean),
};

const TailscaleStatusJson = Schema.Struct({
  Version: lenient(Schema.String),
  BackendState: lenient(Schema.String),
  TUN: lenient(Schema.Boolean),
  // Keyed by user ID; JSON keys are strings, so the IDs stay exact.
  User: lenient(Schema.Record(Schema.String, Schema.Struct({ LoginName: lenient(Schema.String) }))),
  Health: lenient(Schema.Array(Schema.String)),
  CertDomains: lenient(Schema.Array(Schema.String)),
  CurrentTailnet: lenient(Schema.Struct({ MagicDNSEnabled: lenient(Schema.Boolean) })),
  Self: lenient(
    Schema.Struct({
      ...TailscaleStatusNodeFields,
      CapMap: lenient(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  Peer: lenient(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        ...TailscaleStatusNodeFields,
        Online: lenient(Schema.Boolean),
        LastSeen: lenient(Schema.String),
        AltSharerUserID: lenient(Schema.String),
        ShareeNode: lenient(Schema.Boolean),
        CurAddr: lenient(Schema.String),
        Relay: lenient(Schema.String),
        PeerRelay: lenient(Schema.String),
        Active: lenient(Schema.Boolean),
      }),
    ),
  ),
});

export interface TailscalePeer {
  readonly stableNodeId: string;
  readonly hostName: string | null;
  readonly magicDnsName: string | null;
  readonly os: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
  /** For `whois` on a peer with no IPv4 address. */
  readonly tailnetIpv6Addresses: readonly string[];
  readonly userId: string | null;
  readonly tags: readonly string[];
  /** Shared in from another tailnet, or owned by a user this tailnet shares to. */
  readonly sharedIn: boolean;
  /** Connected to the control plane. A hint, not proof this device can reach it. */
  readonly online: boolean;
  readonly lastSeen: string | null;
  readonly keyExpired: boolean;
  /** The path is direct (`curAddr`), DERP (`relay`) or a peer relay only while `active`. */
  readonly active: boolean;
  readonly curAddr: string | null;
  readonly relay: string | null;
  readonly peerRelay: string | null;
}

export interface TailscaleStatus {
  /** The daemon's version, such as `1.102.2-t6cac91817-g…`. */
  readonly version: string | null;
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
  /**
   * `tailscale serve --https` needs the `https` capability, which the control
   * plane grants once the tailnet enables HTTPS certificates. `null` when the
   * CLI reports no capability map (older CLI), so callers still attempt serve.
   */
  readonly httpsServeEnabled: boolean | null;
  /** `Running`, `NeedsLogin`, `NeedsMachineAuth`, `Stopped`, `Starting` or `NoState`. */
  readonly backendState: string | null;
  readonly selfNodeId: string | null;
  readonly selfUserId: string | null;
  /** Non-empty on a tagged node, which has no user identity. */
  readonly selfTags: readonly string[];
  readonly keyExpiry: string | null;
  readonly keyExpired: boolean;
  readonly health: readonly string[];
  readonly magicDnsEnabled: boolean | null;
  readonly certDomains: readonly string[];
  /**
   * Userspace networking hands tailnet connections to the server from
   * loopback, so `whois` cannot name the peer. `null` on older CLIs.
   */
  readonly userspaceNetworking: boolean | null;
  readonly peers: readonly TailscalePeer[];
  /** Users this node can see, by user ID. */
  readonly users: ReadonlyArray<{ readonly userId: string; readonly loginName: string | null }>;
}

const collectOutput = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function normalizeMagicDnsName(dnsName: string | undefined): string | null {
  const normalized = dnsName?.trim().replace(/\.$/u, "") ?? "";
  return normalized.length > 0 ? normalized : null;
}

const nonEmptyOrNull = (value: string | undefined): string | null =>
  value !== undefined && value.trim().length > 0 ? value : null;

// Go writes an unset `time.Time` as its zero value rather than omitting it.
const timeOrNull = (value: string | undefined): string | null =>
  value === undefined || value.startsWith("0001-01-01") ? null : value;

/** A dotted IPv4 address in 100.64/10, where Tailscale assigns from. Other VPNs share the range. */
export const isTailscaleIpv4Address = (address: string): boolean =>
  NodeNet.isIPv4(address) && isSharedAddressSpaceHost(address);

const tailnetIpv4AddressesOf = (addresses: ReadonlyArray<string> | undefined) =>
  (addresses ?? []).filter(isTailscaleIpv4Address);

// Tailscale assigns IPv6 addresses from fd7a:115c:a1e0::/48.
const tailnetIpv6AddressesOf = (addresses: ReadonlyArray<string> | undefined) =>
  (addresses ?? []).filter(
    (address) => NodeNet.isIPv6(address) && address.toLowerCase().startsWith("fd7a:115c:a1e0:"),
  );

const decodeTailscaleStatusJson = decodeTailscaleJson(
  TailscaleStatusJson,
  (cause) => new TailscaleStatusParseError({ cause }),
);

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.map((parsed): TailscaleStatus => {
      const self = parsed.Self;
      const peers = Object.values(parsed.Peer ?? {}).flatMap((peer): TailscalePeer[] => {
        const stableNodeId = nonEmptyOrNull(peer.ID);
        if (stableNodeId === null) return [];
        return [
          {
            stableNodeId,
            hostName: nonEmptyOrNull(peer.HostName),
            magicDnsName: normalizeMagicDnsName(peer.DNSName),
            os: nonEmptyOrNull(peer.OS),
            tailnetIpv4Addresses: tailnetIpv4AddressesOf(peer.TailscaleIPs),
            tailnetIpv6Addresses: tailnetIpv6AddressesOf(peer.TailscaleIPs),
            userId: nonEmptyOrNull(peer.UserID),
            tags: peer.Tags ?? [],
            sharedIn:
              (peer.AltSharerUserID !== undefined && peer.AltSharerUserID !== "0") ||
              peer.ShareeNode === true,
            online: peer.Online === true,
            lastSeen: timeOrNull(peer.LastSeen),
            keyExpired: peer.Expired === true,
            active: peer.Active === true,
            curAddr: nonEmptyOrNull(peer.CurAddr),
            relay: nonEmptyOrNull(peer.Relay),
            peerRelay: nonEmptyOrNull(peer.PeerRelay),
          },
        ];
      });
      return {
        version: nonEmptyOrNull(parsed.Version),
        magicDnsName: normalizeMagicDnsName(self?.DNSName),
        tailnetIpv4Addresses: tailnetIpv4AddressesOf(self?.TailscaleIPs),
        httpsServeEnabled: self?.CapMap === undefined ? null : Object.hasOwn(self.CapMap, "https"),
        backendState: nonEmptyOrNull(parsed.BackendState),
        selfNodeId: nonEmptyOrNull(self?.ID),
        selfUserId: nonEmptyOrNull(self?.UserID),
        selfTags: self?.Tags ?? [],
        keyExpiry: timeOrNull(self?.KeyExpiry),
        keyExpired: self?.Expired === true,
        health: parsed.Health ?? [],
        magicDnsEnabled: parsed.CurrentTailnet?.MagicDNSEnabled ?? null,
        certDomains: parsed.CertDomains ?? [],
        userspaceNetworking: parsed.TUN === undefined ? null : !parsed.TUN,
        peers,
        users: Object.entries(parsed.User ?? {}).map(([userId, user]) => ({
          userId,
          loginName: nonEmptyOrNull(user.LoginName),
        })),
      };
    }),
  );

/** Spawns the CLI and returns its stdout. Errors carry lengths and a diagnostic, never output. */
const runTailscale = Effect.fn("tailscale.runTailscale")(function* (
  subcommand: TailscaleSubcommand,
  args: readonly string[],
  timeout: Duration.Duration,
  use: TailscaleCliUse,
): Effect.fn.Return<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcess.Platform;
  const executable = tailscaleCommandForPlatform(hostPlatform);
  const commandContext = {
    executable,
    subcommand,
    argumentCount: args.length,
  };
  const spawnAt = (path: string) =>
    spawner.spawn(
      ChildProcess.make(path, [...args], {
        forceKillAfter: TAILSCALE_KILL_GRACE,
        // tailscaled reads TS_BE_CLI to act as the CLI (cmd/tailscaled/tailscaled.go).
        ...(path === DARWIN_APP_BUNDLE_CLI ? { env: { TS_BE_CLI: "1" }, extendEnv: true } : {}),
      }),
    );
  const fallbacks =
    hostPlatform !== "darwin"
      ? []
      : use === "active"
        ? [...DARWIN_CLI_PATHS, DARWIN_APP_BUNDLE_CLI]
        : DARWIN_CLI_PATHS;
  const spawnFirstInstalled = fallbacks.reduce(
    (attempt, path) =>
      attempt.pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => spawnAt(path),
        ),
      ),
    spawnAt(executable),
  );
  return yield* Effect.gen(function* () {
    const child = yield* spawnFirstInstalled.pipe(
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
        collectOutput(child.stdout),
        collectOutput(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
    );
    if (exitCode !== 0) {
      const stderrDiagnostic = stderrDiagnosticOf(stderr);
      return yield* new TailscaleCommandExitError({
        ...commandContext,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        ...(stderrDiagnostic !== undefined ? { stderrDiagnostic } : {}),
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

const readTailscaleStatusOutput = (use: TailscaleCliUse) =>
  runTailscale("status", ["status", "--json"], TAILSCALE_STATUS_TIMEOUT, use);

export const readTailscaleStatus = (use: TailscaleCliUse) =>
  readTailscaleStatusOutput(use).pipe(Effect.flatMap(parseTailscaleStatus));

/** What a failed `tailscale status` read says about Tailscale on this machine. */
export const tailscaleStateOfReadError = (
  error: TailscaleCommandError | TailscaleStatusParseError,
): "not_installed" | "not_running" | "needs_login" | "unreadable" => {
  switch (error._tag) {
    case "TailscaleCommandSpawnError":
      return "not_installed";
    case "TailscaleCommandExitError":
      // The CLI exits non-zero mostly when it cannot reach tailscaled.
      switch (error.stderrDiagnostic) {
        case "not-logged-in":
          return "needs_login";
        case "permission-denied":
          return "unreadable";
        default:
          return "not_running";
      }
    default:
      return "unreadable";
  }
};

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

export const readTailscaleExitNode = readTailscaleStatusOutput("passive").pipe(
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

export const readTailscaleSshEnabled = runTailscale(
  "debug",
  ["debug", "prefs"],
  TAILSCALE_STATUS_TIMEOUT,
  "passive",
).pipe(Effect.flatMap(parseTailscaleSshEnabled));

// The node fields that decide trust are strict: missing required ones, or a
// wrong type on an optional one, fail rather than read as empty.
const TailscaleWhoisJson = Schema.Struct({
  Node: Schema.Struct({
    StableID: Schema.NonEmptyString,
    User: Schema.NonEmptyString,
    Addresses: Schema.Array(Schema.String),
    AllowedIPs: Schema.Array(Schema.String),
    Tags: Schema.optional(Schema.Array(Schema.String)),
    PrimaryRoutes: Schema.optional(Schema.Array(Schema.String)),
    Sharer: Schema.optional(Schema.String),
    ComputedName: lenient(Schema.String),
    Hostinfo: lenient(Schema.Struct({ OS: lenient(Schema.String) })),
  }),
  UserProfile: lenient(
    Schema.Struct({ LoginName: lenient(Schema.String), DisplayName: lenient(Schema.String) }),
  ),
  // The app capabilities tailnet grants give this peer toward this node, by name.
  CapMap: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Schema.Array(Schema.Unknown)))),
  ),
});

export interface TailscaleWhois {
  readonly stableNodeId: string;
  readonly userId: string;
  /** CIDRs, such as `100.64.1.2/32`. */
  readonly addresses: readonly string[];
  /** Wider than `addresses` on a subnet router or exit node. */
  readonly allowedIps: readonly string[];
  readonly tags: readonly string[];
  readonly primaryRoutes: readonly string[];
  /** Set when the node is shared in from another tailnet. */
  readonly sharerUserId: string | null;
  readonly computedName: string | null;
  readonly os: string | null;
  readonly loginName: string | null;
  readonly displayName: string | null;
  /** Each granted app capability's values, one per matching grant. */
  readonly capabilities: Readonly<Record<string, ReadonlyArray<unknown>>>;
}

const decodeTailscaleWhoisJson = decodeTailscaleJson(
  TailscaleWhoisJson,
  (cause) => new TailscaleWhoisParseError({ cause }),
);

/** Tailscale omits empty fields, so a missing `Tags`, `PrimaryRoutes` or `Sharer` means none. */
export const parseTailscaleWhois = (
  rawWhoisJson: string,
): Effect.Effect<TailscaleWhois, TailscaleWhoisParseError> =>
  decodeTailscaleWhoisJson(rawWhoisJson).pipe(
    Effect.map(({ Node: node, UserProfile: profile, CapMap: capMap }) => ({
      stableNodeId: node.StableID,
      userId: node.User,
      addresses: node.Addresses,
      allowedIps: node.AllowedIPs,
      tags: node.Tags ?? [],
      primaryRoutes: node.PrimaryRoutes ?? [],
      sharerUserId: node.Sharer === undefined || node.Sharer === "0" ? null : node.Sharer,
      computedName: nonEmptyOrNull(node.ComputedName),
      os: nonEmptyOrNull(node.Hostinfo?.OS),
      loginName: nonEmptyOrNull(profile?.LoginName),
      displayName: nonEmptyOrNull(profile?.DisplayName),
      capabilities: Object.fromEntries(
        Object.entries(capMap ?? {}).map(([name, values]) => [name, values ?? []]),
      ),
    })),
  );

/** Asks the local daemon which node and user own a tailnet address. Only sign-in and `t3 up` ask. */
export const readTailscaleWhois = Effect.fn("tailscale.readTailscaleWhois")(function* (
  address: string,
) {
  // `--` keeps an address that starts with `-` from reading as a flag.
  const stdout = yield* runTailscale(
    "whois",
    ["whois", "--json", "--", address],
    TAILSCALE_STATUS_TIMEOUT,
    "active",
  );
  return yield* parseTailscaleWhois(stdout);
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

interface TailscaleServeTarget {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}

const serveProxyTarget = (input: TailscaleServeTarget): string =>
  `http://${input.localHost ?? "127.0.0.1"}:${input.localPort}`;

export const ensureTailscaleServe = (
  input: TailscaleServeTarget,
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const args = ["serve", "--bg", `--https=${servePort}`, serveProxyTarget(input)];
  return runTailscale("serve", args, TAILSCALE_SERVE_TIMEOUT, "active").pipe(Effect.asVoid);
};

export const disableTailscaleServe = Effect.fn("tailscale.disableTailscaleServe")(function* (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.fn.Return<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  yield* runTailscale(
    "serve",
    ["serve", `--https=${servePort}`, "off"],
    TAILSCALE_SERVE_TIMEOUT,
    "active",
  );
});

const TailscaleServeConfigFields = {
  AllowFunnel: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  TCP: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        HTTPS: Schema.optional(Schema.Boolean),
        TCPForward: Schema.optional(Schema.String),
      }),
    ),
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
};

// The CLI prints `null` when nothing is served.
const TailscaleServeConfigJson = Schema.NullOr(
  Schema.Struct({
    ...TailscaleServeConfigFields,
    Foreground: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct(TailscaleServeConfigFields)),
    ),
  }),
);

type TailscaleServeConfig = NonNullable<typeof TailscaleServeConfigJson.Type>;

const decodeTailscaleServeConfigJson = Schema.decodeEffect(
  Schema.fromJsonString(TailscaleServeConfigJson),
);

const readTailscaleServeConfig = runTailscale(
  "serve",
  ["serve", "status", "--json"],
  TAILSCALE_STATUS_TIMEOUT,
  "active",
).pipe(
  Effect.flatMap((stdout) =>
    decodeTailscaleServeConfigJson(stdout).pipe(
      Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    ),
  ),
);

/** Who holds an HTTPS Serve port: nobody, a root proxy to `target`, or something T3 must not replace. */
type TailscaleServePortHolder =
  | { readonly _tag: "free" }
  | { readonly _tag: "proxy"; readonly target: string }
  | { readonly _tag: "other" };

const tailscaleServePortHolder = (
  config: TailscaleServeConfig | null,
  servePort: number,
): TailscaleServePortHolder => {
  if (config === null) return { _tag: "free" };
  for (const scope of [...Object.values(config.Foreground ?? {}), config]) {
    // Serve clears Funnel on this port; foreground mappings belong to another CLI session.
    if (
      Object.entries(scope.AllowFunnel ?? {}).some(
        ([key, enabled]) => enabled && key.endsWith(`:${servePort}`),
      )
    ) {
      return { _tag: "other" };
    }
    const listener = scope.TCP?.[String(servePort)];
    // `serve --https` switches the whole port to HTTPS, so a plain HTTP or TCP listener is taken.
    if (
      listener !== undefined &&
      (scope !== config || listener.HTTPS !== true || listener.TCPForward !== undefined)
    ) {
      return { _tag: "other" };
    }
    const webEntries = Object.entries(scope.Web ?? {}).filter(([hostPort]) =>
      hostPort.endsWith(`:${servePort}`),
    );
    if (webEntries.length > 1 || (scope !== config && webEntries.length > 0)) {
      return { _tag: "other" };
    }
    for (const [, web] of webEntries) {
      const root = web.Handlers?.["/"];
      if (root !== undefined) {
        return root.Proxy !== undefined ? { _tag: "proxy", target: root.Proxy } : { _tag: "other" };
      }
    }
  }
  return { _tag: "free" };
};

const LOOPBACK_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Only a refused loopback connection proves a target stopped. A timeout or a
// remote target may be a live server that is slow or out of reach from here.
const proxyTargetIsLive = Effect.fn("tailscale.proxyTargetIsLive")((
  target: string,
): Effect.Effect<boolean> => {
  const url = URL.canParse(target) ? new URL(target) : undefined;
  if (url === undefined || !LOOPBACK_PROXY_HOSTS.has(url.hostname)) {
    return Effect.succeed(true);
  }
  const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
  const host = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  return Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host, port });
    const settle = (live: boolean) => {
      socket.destroy();
      resume(Effect.succeed(live));
    };
    socket.setTimeout(Duration.toMillis(TAILSCALE_PROBE_TIMEOUT));
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(true));
    socket.once("error", (error: NodeJS.ErrnoException) => settle(error.code !== "ECONNREFUSED"));
    return Effect.sync(() => socket.destroy());
  });
});

/**
 * Points the Serve port at this server unless another live server holds it.
 * A root that already points here, or at a stopped loopback server, is replaced.
 */
export const claimTailscaleServe = Effect.fn("tailscale.claimTailscaleServe")(function* (
  input: TailscaleServeTarget,
) {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const holder = tailscaleServePortHolder(yield* readTailscaleServeConfig, servePort);
  if (
    holder._tag === "other" ||
    (holder._tag === "proxy" &&
      holder.target !== serveProxyTarget(input) &&
      (yield* proxyTargetIsLive(holder.target)))
  ) {
    return yield* new TailscaleServeOccupiedError({ servePort });
  }
  yield* ensureTailscaleServe(input);
  // Serve has no conditional write, so a server that checked at the same time
  // may have written after us. The caller retries and finds it live.
  const after = tailscaleServePortHolder(yield* readTailscaleServeConfig, servePort);
  if (after._tag !== "proxy" || after.target !== serveProxyTarget(input)) {
    return yield* new TailscaleServeOccupiedError({ servePort });
  }
});

/**
 * Removes the Serve root only while it still points at this server, and keeps
 * other handlers on the port. Returns whether it removed anything.
 */
export const releaseTailscaleServe = Effect.fn("tailscale.releaseTailscaleServe")(function* (
  input: TailscaleServeTarget,
) {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const holder = tailscaleServePortHolder(yield* readTailscaleServeConfig, servePort);
  if (holder._tag !== "proxy" || holder.target !== serveProxyTarget(input)) {
    return false;
  }
  yield* runTailscale(
    "serve",
    ["serve", `--https=${servePort}`, "--set-path=/", "off"],
    TAILSCALE_SERVE_TIMEOUT,
    "active",
  );
  return true;
});

const T3EnvironmentIdentity = Schema.Struct({ environmentId: Schema.String });

/** The environment ID the T3 server at `baseUrl` reports, or none when nothing answers as one. */
export const readT3EnvironmentId = Effect.fn("tailscale.readT3EnvironmentId")(
  function* (input: { readonly baseUrl: string; readonly timeout?: Duration.Input }) {
    const client = yield* HttpClient.HttpClient;
    const url = new URL("/.well-known/t3/environment", input.baseUrl);
    const identity = yield* client
      .execute(HttpClientRequest.get(url.toString()))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(T3EnvironmentIdentity)),
        Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT),
      );
    return Option.map(identity, (body) => body.environmentId);
  },
  Effect.orElseSucceed(() => Option.none<string>()),
);

/** True only when `baseUrl` answers as `environmentId`, so a Serve URL another server holds does not count. */
export const probeTailscaleHttpsEndpoint = Effect.fn("tailscale.probeTailscaleHttpsEndpoint")(
  function* (input: {
    readonly baseUrl: string;
    readonly environmentId: string;
    readonly timeout?: Duration.Input;
  }) {
    const served = yield* readT3EnvironmentId(input);
    return Option.contains(served, input.environmentId);
  },
);
