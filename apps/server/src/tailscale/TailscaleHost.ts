import * as NodeOS from "node:os";

import {
  isTailscaleIpv4Address,
  readTailscaleStatus,
  readTailscaleWhois,
  type TailscaleCommandError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
  type TailscaleWhois,
  type TailscaleWhoisParseError,
} from "@t3tools/tailscale";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

const STATUS_TTL = Duration.seconds(5);
// Short, so a renewal reads a node that was tagged or removed seconds ago.
const WHOIS_TTL = Duration.seconds(3);
const WHOIS_CACHE_CAPACITY = 256;
// Lookups that miss the cache, per address. Each one spawns the CLI.
const WHOIS_LOOKUPS_PER_WINDOW = 10;
const WHOIS_WINDOW_MS = 60_000;

export class TailscaleWhoisRateLimitedError extends Schema.TaggedError<TailscaleWhoisRateLimitedError>()(
  "TailscaleWhoisRateLimitedError",
  {},
) {
  override get message(): string {
    return "Too many Tailscale whois lookups for one address.";
  }
}

export type TailscaleStatusError = TailscaleCommandError | TailscaleStatusParseError;
export type TailscaleWhoisError =
  | TailscaleCommandError
  | TailscaleWhoisParseError
  | TailscaleWhoisRateLimitedError;

/** This host's Tailscale daemon, with reads shared between callers. */
export class TailscaleHost extends Context.Service<
  TailscaleHost,
  {
    /**
     * A Tailscale feature is on, or an interface holds a 100.64/10 address.
     * Reads nobody asked for, such as health facts, skip the CLI otherwise.
     */
    readonly inUse: Effect.Effect<boolean>;
    /** `tailscale status`, single-flight and kept for a few seconds. */
    readonly status: Effect.Effect<TailscaleStatus, TailscaleStatusError>;
    /**
     * Who owns a tailnet address. Single-flight per address, kept for a few
     * seconds at most, and rate limited per address. Policy scans and rechecks
     * (`fromServer`) skip the cache and the limit; their callers bound how often they run.
     */
    readonly whois: (
      address: string,
      options?: { readonly fromServer?: boolean },
    ) => Effect.Effect<TailscaleWhois, TailscaleWhoisError>;
  }
>()("t3/tailscale/TailscaleHost") {}

/**
 * Sign-in trusts that whois JSON omits only empty fields, so a missing `Tags`
 * or `Sharer` reads as none. That was checked on 1.102.2. Releases before
 * 1.80 (early 2025) are untested and well past Tailscale's update cadence, so
 * they are refused rather than trusted to report every field.
 */
export const MINIMUM_TAILSCALE_VERSION = "1.80.0";

export const isSupportedTailscaleVersion = (version: string | null): boolean => {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)/u.exec(value)?.slice(1, 4).map(Number);
  const actual = version === null ? undefined : parse(version);
  const minimum = parse(MINIMUM_TAILSCALE_VERSION)!;
  if (actual === undefined) return false;
  const index = actual.findIndex((part, position) => part !== minimum[position]);
  return index === -1 || actual[index]! > minimum[index]!;
};

/**
 * The Tailscale user that owns this host: its own user when untagged. A tagged
 * node has no user identity, so it needs the owner `t3 up` stored.
 */
export const tailnetOwnerUserId = (
  status: Pick<TailscaleStatus, "selfTags" | "selfUserId">,
  configuredOwnerUserId: string | undefined,
): string | null =>
  status.selfTags.length === 0 ? status.selfUserId : (configuredOwnerUserId ?? null);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const featureOn =
    config.tailscaleServeEnabled ||
    config.tailscaleSignInEnabled === true ||
    config.tailscaleOnly === true;
  const inUse = featureOn
    ? Effect.succeed(true)
    : Effect.sync(() =>
        Object.values(NodeOS.networkInterfaces()).some((entries) =>
          entries?.some((entry) => !entry.internal && isTailscaleIpv4Address(entry.address)),
        ),
      );
  const status = yield* Effect.cachedWithTTL(
    readTailscaleStatus(featureOn ? "active" : "passive").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    STATUS_TTL,
  );

  const lookupsByAddress = yield* Ref.make(new Map<string, ReadonlyArray<number>>());
  const takeLookup = Effect.fnUntraced(function* (address: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(lookupsByAddress, (current) => {
      const next = new Map<string, ReadonlyArray<number>>();
      for (const [key, times] of current) {
        const recent = times.filter((time) => now - time < WHOIS_WINDOW_MS);
        if (recent.length > 0) next.set(key, recent);
      }
      const recent = next.get(address) ?? [];
      if (recent.length >= WHOIS_LOOKUPS_PER_WINDOW) return [false, next] as const;
      next.set(address, [...recent, now]);
      return [true, next] as const;
    });
  });

  const whoisCache = yield* Cache.makeWith(
    Effect.fn("TailscaleHost.whoisLookup")(function* (address: string) {
      if (!(yield* takeLookup(address))) {
        return yield* new TailscaleWhoisRateLimitedError({});
      }
      return yield* readTailscaleWhois(address).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    }),
    { capacity: WHOIS_CACHE_CAPACITY, timeToLive: () => WHOIS_TTL },
  );

  const whois: TailscaleHost["Service"]["whois"] = (address, options) =>
    options?.fromServer === true
      ? readTailscaleWhois(address).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
      : Cache.get(whoisCache, address);

  return TailscaleHost.of({ inUse, status, whois });
});

export const layer = Layer.effect(TailscaleHost, make);
