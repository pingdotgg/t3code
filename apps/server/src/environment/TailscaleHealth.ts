import {
  type ServerTailscaleIssue,
  type ServerTailscaleStatus,
  tailscaleIssueHeadline,
  tailscaleStateFromBackend,
  type TailscaleState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
  tailscaleStateOfReadError,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";

const CACHE_TTL = Duration.seconds(30);
const REFRESH_INTERVAL = Duration.minutes(1);
const KEY_EXPIRY_WARNING_MS = Duration.toMillis(Duration.days(7));
const ADMIN_MACHINES_URL = "https://login.tailscale.com/admin/machines";
const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

export type TailscaleStatusRead = Result.Result<
  TailscaleStatus,
  TailscaleCommandError | TailscaleStatusParseError
>;

export const NO_IPV4_FIX =
  "Allow IPv4 for this machine in your tailnet policy. Tailscale sign-in needs it.";

/** Linux and other headless hosts use the CLI; macOS and Windows users usually have the app. */
const usesApp = (platform: NodeJS.Platform) => platform === "darwin" || platform === "win32";

export function stateFix(
  state: Exclude<TailscaleState, "running">,
  platform: NodeJS.Platform,
): string {
  const app = usesApp(platform);
  switch (state) {
    case "not_installed":
      return "Install Tailscale from https://tailscale.com/download, or put its CLI on PATH.";
    case "not_running":
      return app ? "Open the Tailscale app." : "Run `sudo systemctl enable --now tailscaled`.";
    case "needs_login":
      return app ? "Open the Tailscale app and log in." : "Run `sudo tailscale up` and log in.";
    case "needs_machine_approval":
      return `Approve this machine at ${ADMIN_MACHINES_URL}.`;
    case "stopped":
      return app ? "Turn on Tailscale in the Tailscale app." : "Run `sudo tailscale up`.";
    case "starting":
      return "Wait a few seconds. If it stays, restart Tailscale.";
    case "unreadable":
      return "Run `tailscale status` to see the error. Update Tailscale if it is old.";
  }
}

export function readErrorFacts(
  error: TailscaleCommandError | TailscaleStatusParseError,
  platform: NodeJS.Platform,
): ServerTailscaleIssue & { readonly cause: Exclude<TailscaleState, "running"> } {
  const cause = tailscaleStateOfReadError(error);
  if (error._tag === "TailscaleCommandTimeoutError") {
    return { cause, fix: "`tailscale status` did not answer. Restart Tailscale." };
  }
  if (
    error._tag === "TailscaleCommandExitError" &&
    error.stderrDiagnostic === "permission-denied"
  ) {
    return { cause, fix: "Let the user that runs T3 Code run `tailscale status`." };
  }
  return { cause, fix: stateFix(cause, platform) };
}

/** Turns one `tailscale status` read into the facts the CLI prints and clients show. */
export function classifyTailscaleHealth(
  read: TailscaleStatusRead,
  input: { readonly checkedAt: string; readonly now: number; readonly platform: NodeJS.Platform },
): ServerTailscaleStatus {
  const { checkedAt, now, platform } = input;
  if (Result.isFailure(read)) {
    const issue = readErrorFacts(read.failure, platform);
    return { state: issue.cause, checkedAt, magicDnsName: null, keyExpiry: null, issues: [issue] };
  }
  const status = read.success;
  const state = tailscaleStateFromBackend(status.backendState);
  const issues: Array<ServerTailscaleIssue> = [];
  if (state !== "running") issues.push({ cause: state, fix: stateFix(state, platform) });
  // Each stops Tailscale sign-in, so they come before the warnings below.
  if (state === "running" && !TailscaleHost.isSupportedTailscaleVersion(status.version)) {
    issues.push({
      cause: "outdated",
      fix: `Update Tailscale to ${TailscaleHost.MINIMUM_TAILSCALE_VERSION} or newer.`,
    });
  }
  if (state === "running" && status.tailnetIpv4Addresses.length === 0) {
    issues.push({ cause: "no_ipv4", fix: NO_IPV4_FIX });
  }

  // NaN when the key never expires, which fails both comparisons.
  const expiresAt = status.keyExpiry === null ? Number.NaN : Date.parse(status.keyExpiry);
  const disableExpiry = `turn off key expiry for this machine at ${ADMIN_MACHINES_URL}`;
  if (status.keyExpired || expiresAt <= now) {
    issues.push({
      cause: "key_expired",
      fix: usesApp(platform)
        ? `Log in again in the Tailscale app, or ${disableExpiry}.`
        : `Run \`sudo tailscale up --force-reauth\`, or ${disableExpiry}.`,
    });
  } else if (expiresAt - now <= KEY_EXPIRY_WARNING_MS) {
    issues.push({
      cause: "key_expiring",
      fix: `Log in again before it expires, or ${disableExpiry}.`,
    });
  }

  // Health repeats the state while Tailscale is not running.
  if (state === "running") {
    for (const message of status.health) {
      issues.push({ cause: "health_warning", fix: "Run `tailscale status` for details.", message });
    }
    if (status.httpsServeEnabled === false && status.certDomains.length === 0) {
      issues.push({
        cause: "https_off",
        fix: `Turn on HTTPS Certificates at ${ADMIN_DNS_URL}. Tailscale HTTPS needs them.`,
      });
    }
    if (status.magicDnsEnabled === false) {
      issues.push({ cause: "magic_dns_off", fix: `Turn on MagicDNS at ${ADMIN_DNS_URL}.` });
    }
    if (status.userspaceNetworking === true) {
      issues.push({
        cause: "userspace_networking",
        fix: "Run tailscaled with a TUN device, so T3 Code can see which device connects.",
      });
    }
  }
  return {
    state,
    checkedAt,
    magicDnsName: status.magicDnsName,
    keyExpiry: status.keyExpiry,
    issues,
  };
}

/** What `t3 tailscale status` prints. */
export function formatTailscaleHealth(status: ServerTailscaleStatus): string {
  const now = Date.parse(status.checkedAt);
  const state = status.state.replaceAll("_", " ");
  return [
    `Tailscale: ${state}${status.magicDnsName ? ` (${status.magicDnsName})` : ""}`,
    ...(status.issues.length === 0 ? ["✓ Nothing to fix"] : []),
    ...status.issues.flatMap((issue) => [
      "",
      `✕ ${tailscaleIssueHeadline("this machine", issue, status.keyExpiry, now)}`,
      `  Fix: ${issue.fix}`,
    ]),
  ].join("\n");
}

const readTailscaleHealthWith = Effect.fn("TailscaleHealth.read")(function* <R>(
  status: Effect.Effect<TailscaleStatus, TailscaleCommandError | TailscaleStatusParseError, R>,
) {
  const read = yield* Effect.result(status);
  const now = yield* DateTime.now;
  return classifyTailscaleHealth(read, {
    checkedAt: DateTime.formatIso(now),
    now: DateTime.toEpochMillis(now),
    platform: yield* HostProcess.Platform,
  });
});

/** Reads and classifies now, for the CLI. The server goes through the cache in {@link TailscaleHealth}. */
export const readTailscaleHealth = readTailscaleHealthWith(readTailscaleStatus("active"));

export class TailscaleHealth extends Context.Service<
  TailscaleHealth,
  {
    /**
     * At most 30 s old. Concurrent callers share one read. Undefined, with no
     * read, while this machine shows no sign of using Tailscale.
     */
    readonly check: Effect.Effect<ServerTailscaleStatus | undefined>;
    /** `check` now and once a minute, for a client that stays connected. */
    readonly reads: Stream.Stream<ServerTailscaleStatus | undefined>;
  }
>()("t3/environment/TailscaleHealth") {}

const make = Effect.gen(function* () {
  const host = yield* TailscaleHost.TailscaleHost;
  const read = yield* Effect.cachedWithTTL(readTailscaleHealthWith(host.status), CACHE_TTL);
  const check = host.inUse.pipe(Effect.flatMap((inUse) => (inUse ? read : Effect.undefined)));
  const reads = Stream.tick(REFRESH_INTERVAL).pipe(Stream.mapEffect(() => check));
  return TailscaleHealth.of({ check, reads });
});

export const layer = Layer.effect(TailscaleHealth, make);
