import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Ports Tailscale Serve is asked to fall back to when the preferred one is
 * already taken by something else on the node. Both are conventional HTTPS
 * alternates that Tailscale accepts for serve and funnel alike.
 */
export const DEFAULT_TAILSCALE_SERVE_FALLBACK_PORTS: ReadonlyArray<number> = [8443, 10000];

export class TailscaleServeConfigParseError extends Schema.TaggedErrorClass<TailscaleServeConfigParseError>()(
  "TailscaleServeConfigParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale serve status JSON.";
  }
}

/**
 * One HTTPS port the node's serve config already has a web handler on, with
 * every proxy target mounted under it. A port present with no proxy targets is
 * still occupied — by a text or file handler this code cannot classify — and
 * is deliberately represented as an empty target list rather than omitted.
 */
export interface TailscaleServeMount {
  readonly port: number;
  readonly proxyTargets: ReadonlyArray<string>;
}

const ServeConfigJson = Schema.Struct({
  Web: Schema.optional(Schema.Unknown),
  Foreground: Schema.optional(Schema.Unknown),
});

const decodeServeConfigJson = Schema.decodeEffect(Schema.fromJsonString(ServeConfigJson));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `"host.tail.ts.net:443"` -> `443`. */
const parseHostPort = (hostPort: string): number | null => {
  const separatorIndex = hostPort.lastIndexOf(":");
  if (separatorIndex < 0) {
    return null;
  }
  const port = Number.parseInt(hostPort.slice(separatorIndex + 1), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

const collectWebMounts = (web: unknown, into: Map<number, Array<string>>): void => {
  if (!isRecord(web)) {
    return;
  }
  for (const [hostPort, config] of Object.entries(web)) {
    const port = parseHostPort(hostPort);
    if (port === null) {
      continue;
    }
    const targets = into.get(port) ?? [];
    const handlers = isRecord(config) ? config["Handlers"] : undefined;
    if (isRecord(handlers)) {
      for (const handler of Object.values(handlers)) {
        const proxy = isRecord(handler) ? handler["Proxy"] : undefined;
        if (typeof proxy === "string" && proxy.length > 0) {
          targets.push(proxy);
        }
      }
    }
    into.set(port, targets);
  }
};

export const parseTailscaleServeConfig = (
  rawConfigJson: string,
): Effect.Effect<ReadonlyArray<TailscaleServeMount>, TailscaleServeConfigParseError> =>
  decodeServeConfigJson(rawConfigJson).pipe(
    Effect.mapError((cause) => new TailscaleServeConfigParseError({ cause })),
    Effect.map((parsed) => {
      const mounts = new Map<number, Array<string>>();
      collectWebMounts(parsed.Web, mounts);
      // Foreground sessions (`tailscale serve` without `--bg`) hold their own
      // config tree and occupy ports just as durably while they run.
      if (isRecord(parsed.Foreground)) {
        for (const session of Object.values(parsed.Foreground)) {
          collectWebMounts(isRecord(session) ? session["Web"] : undefined, mounts);
        }
      }
      return [...mounts.entries()]
        .map(([port, proxyTargets]) => ({ port, proxyTargets }))
        .sort((left, right) => left.port - right.port);
    }),
  );

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The loopback port a serve proxy target points at, or null when the target is
 * not a loopback HTTP(S) URL this process could plausibly own.
 */
export const loopbackProxyPort = (proxyTarget: string): number | null => {
  let url: URL;
  try {
    url = new URL(proxyTarget);
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(url.host)) {
    return null;
  }
  if (url.port.length > 0) {
    const port = Number.parseInt(url.port, 10);
    return Number.isInteger(port) ? port : null;
  }
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return null;
};

/**
 * Picks the HTTPS port to run Tailscale Serve on.
 *
 * A port is claimable when it is unmounted, already points at this server, or
 * points only at loopback ports nothing is listening on (a mount left behind
 * by a crashed sidecar — the desktop app binds an ephemeral port, so its own
 * leftovers look foreign on the next launch). Anything else belongs to a live
 * service on the node: taking it would break that service, and tearing it down
 * on quit would delete a config this app never created.
 *
 * Returns null when every candidate is occupied, which the caller must treat
 * as "do not advertise a tailnet endpoint".
 */
export const selectTailscaleServePort = (input: {
  readonly preferredPort: number;
  readonly fallbackPorts?: ReadonlyArray<number>;
  readonly localPort: number;
  readonly mounts: ReadonlyArray<TailscaleServeMount>;
  readonly isStaleLoopbackPort?: (port: number) => boolean;
}): number | null => {
  const isStale = input.isStaleLoopbackPort ?? (() => false);
  const fallbackPorts = input.fallbackPorts ?? DEFAULT_TAILSCALE_SERVE_FALLBACK_PORTS;
  const candidates = [input.preferredPort, ...fallbackPorts].filter(
    (port, index, all) => all.indexOf(port) === index,
  );

  for (const candidate of candidates) {
    const mount = input.mounts.find((entry) => entry.port === candidate);
    if (!mount) {
      return candidate;
    }
    if (mount.proxyTargets.length === 0) {
      continue;
    }
    const claimable = mount.proxyTargets.every((target) => {
      const loopbackPort = loopbackProxyPort(target);
      return loopbackPort !== null && (loopbackPort === input.localPort || isStale(loopbackPort));
    });
    if (claimable) {
      return candidate;
    }
  }

  return null;
};

/** Every distinct loopback port the given mounts proxy to. */
export const loopbackProxyPorts = (
  mounts: ReadonlyArray<TailscaleServeMount>,
): ReadonlyArray<number> => {
  const ports = new Set<number>();
  for (const mount of mounts) {
    for (const target of mount.proxyTargets) {
      const port = loopbackProxyPort(target);
      if (port !== null) {
        ports.add(port);
      }
    }
  }
  return [...ports];
};
