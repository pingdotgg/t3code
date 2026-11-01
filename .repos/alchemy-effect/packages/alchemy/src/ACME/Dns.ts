/**
 * TXT propagation checks.
 *
 * Public recursive resolvers are a poor oracle: they cache negative
 * answers for the zone's SOA minimum (30 minutes is common) and old
 * record sets past their TTL, so a challenge value published a moment ago
 * can stay invisible for far longer than the CA takes to validate. Where
 * `node:dns` is available (deploy time, Fly Machines) the check therefore
 * asks the zone's **authoritative** nameservers directly — the same
 * servers the CA asks. Networks can intercept port 53, so DNS over HTTPS
 * also checks for the exact challenge value. A stale recursive cache must
 * not veto a positive answer; the CA performs its own validation.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { DnsPropagationTimeout } from "./Errors.ts";

export interface PropagationOptions {
  /**
   * Wait before the first lookup to avoid caching an unpublished record.
   * Outside the polling budget. Cloudflare defaults to 60 seconds.
   * @default "0 seconds"
   */
  readonly initialDelay?: Duration.Input | undefined;
  /**
   * Extra wait after the record is seen (or, for solvers that skip the
   * check, the whole wait): anycast edges lag the first one that answers.
   * @default "5 seconds"
   */
  readonly delay?: Duration.Input | undefined;
  /**
   * DNS-over-HTTPS JSON endpoints to use instead of automatic discovery.
   * When supplied, every resolver must return the record. Automatic lookup
   * accepts all discovered nameservers or any default DoH resolver.
   * @default Cloudflare (1.1.1.1) and Google public DNS
   */
  readonly resolvers?: ReadonlyArray<string> | undefined;
  /** Polling budget. @default "45 seconds" */
  readonly timeout?: Duration.Input | undefined;
  /** Polling interval. @default "3 seconds" */
  readonly interval?: Duration.Input | undefined;
}

export const DEFAULT_PROPAGATION_DELAY: Duration.Input = "5 seconds";

/** Sleep `options.delay` (default 5 seconds). */
export const propagationDelay = (
  options: PropagationOptions = {},
): Effect.Effect<void> =>
  Effect.sleep(options.delay ?? DEFAULT_PROPAGATION_DELAY);

// =============================================================================
// Authoritative lookup (node:dns where available)
// =============================================================================

interface NodeDns {
  readonly resolveNs: (name: string) => Promise<string[]>;
  readonly resolve4: (name: string) => Promise<string[]>;
  readonly Resolver: new () => {
    setServers(servers: string[]): void;
    resolveTxt(name: string): Promise<string[][]>;
  };
}

const nodeDns: Effect.Effect<NodeDns | undefined> = Effect.tryPromise(
  () => import("node:dns/promises") as unknown as Promise<NodeDns>,
).pipe(
  Effect.map((mod) =>
    typeof mod?.Resolver === "function" && typeof mod.resolveNs === "function"
      ? mod
      : undefined,
  ),
  Effect.orElseSucceed(() => undefined),
);

/** The zone apex's nameserver IPv4s for `fqdn`, or `[]` when unknown. */
const authoritativeServers = (
  dns: NodeDns,
  fqdn: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const labels = fqdn.replace(/\.$/, "").split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const names = yield* Effect.tryPromise(() =>
        dns.resolveNs(candidate),
      ).pipe(Effect.orElseSucceed(() => [] as string[]));
      if (names.length === 0) continue;
      const addresses = yield* Effect.forEach(
        names,
        (name) =>
          Effect.tryPromise(() => dns.resolve4(name)).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          ),
        { concurrency: "unbounded" },
      );
      return addresses.flat();
    }
    return [];
  });

/** TXT values requested from one nameserver (port 53 may be intercepted). */
const resolveTxtAt = (
  dns: NodeDns,
  server: string,
  fqdn: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const resolver = yield* Effect.sync(() => new dns.Resolver());
    yield* Effect.sync(() => resolver.setServers([server]));
    const records = yield* Effect.tryPromise(() => resolver.resolveTxt(fqdn));
    return records.map((chunks) => chunks.join(""));
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );

export const DEFAULT_RESOLVERS: ReadonlyArray<string> = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];

interface DohAnswer {
  readonly type?: number;
  readonly data?: string;
}

const unquote = (data: string): string =>
  (data.match(/"((?:[^"\\]|\\.)*)"/g) ?? [data])
    .map((part) => part.replace(/^"|"$/g, "").replace(/\\"/g, '"'))
    .join("");

/**
 * TXT values for `fqdn` from one DoH resolver. Any transport or parse
 * failure reads as "no records yet".
 */
export const resolveTxt = (
  resolver: string,
  fqdn: string,
): Effect.Effect<ReadonlyArray<string>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(resolver).pipe(
      HttpClientRequest.setUrlParams({ name: fqdn, type: "TXT" }),
      HttpClientRequest.setHeader("Accept", "application/dns-json"),
    );
    const response = yield* client.execute(request);
    const body = (yield* response.json) as { Answer?: DohAnswer[] };
    return (body.Answer ?? [])
      .filter((answer) => answer.type === 16 && typeof answer.data === "string")
      .map((answer) => unquote(answer.data!));
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );

/**
 * Wait `initialDelay`, then poll for the exact challenge value and wait
 * `delay`. Explicit resolvers must all agree; automatic lookup accepts all
 * discovered nameservers or a positive default DoH answer. Discovery and
 * polling share `timeout`; the delays before and after are outside it.
 */
export const waitForTxt = (
  fqdn: string,
  value: string,
  options: PropagationOptions = {},
): Effect.Effect<void, DnsPropagationTimeout, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const interval = options.interval ?? "3 seconds";
    const timeout = options.timeout ?? "45 seconds";
    // Bounded by `timeout` below, so poll for the caller's whole budget.
    const attempts = Math.max(
      1,
      Math.ceil(Duration.toMillis(timeout) / Duration.toMillis(interval)),
    );
    yield* Effect.sleep(options.initialDelay ?? "0 seconds");
    const propagated = yield* Effect.gen(function* () {
      // Explicit resolvers must work even when node:dns is available.
      const dns = options.resolvers === undefined ? yield* nodeDns : undefined;
      const servers =
        dns === undefined
          ? []
          : yield* authoritativeServers(dns, fqdn).pipe(
              Effect.timeout("5 seconds"),
              Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
            );
      const check = Effect.all(
        {
          direct: Effect.all(
            dns === undefined
              ? []
              : servers.map((server) =>
                  resolveTxtAt(dns, server, fqdn).pipe(
                    Effect.map((values) => values.includes(value)),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
          doh: Effect.all(
            (options.resolvers ?? DEFAULT_RESOLVERS).map((resolver) =>
              resolveTxt(resolver, fqdn).pipe(
                Effect.map((values) => values.includes(value)),
              ),
            ),
            { concurrency: "unbounded" },
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ direct, doh }) =>
          options.resolvers !== undefined
            ? doh.length > 0 && doh.every(Boolean)
            : (direct.length > 0 && direct.every(Boolean)) || doh.some(Boolean),
        ),
      );
      return yield* check.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(interval),
          until: (seen) => seen,
          times: attempts,
        }),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new DnsPropagationTimeout({ fqdn, value })),
      }),
    );
    if (!propagated) {
      return yield* new DnsPropagationTimeout({ fqdn, value });
    }
    yield* propagationDelay(options);
  });
