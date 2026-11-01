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
// Lookups per address from sign-in requests. Each one spawns the CLI.
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
     * `tailscale status` read now. Sign-in decides with it, since a status kept from before
     * a switch to another Tailscale account names the old tailnet's policy and owner.
     */
    readonly freshStatus: Effect.Effect<TailscaleStatus, TailscaleStatusError>;
    /**
     * Who owns a tailnet address, read now and rate limited per address. Policy scans and
     * rechecks (`fromServer`) skip the limit; their callers bound how often they run.
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
  const [status, forgetStatus] = yield* Effect.cachedInvalidateWithTTL(
    readTailscaleStatus(featureOn ? "active" : "passive").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    STATUS_TTL,
  );
  // Kept too, so a reader right after it shares the answer rather than reading again.
  const freshStatus = forgetStatus.pipe(Effect.andThen(status));

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

  // Not cached: after a switch to another Tailscale account, the same address names a
  // device on another tailnet, and a cached answer would carry the old one's grant.
  const whois: TailscaleHost["Service"]["whois"] = Effect.fn("TailscaleHost.whois")(
    function* (address, options) {
      if (options?.fromServer !== true && !(yield* takeLookup(address))) {
        return yield* new TailscaleWhoisRateLimitedError({});
      }
      return yield* readTailscaleWhois(address).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    },
  );

  return TailscaleHost.of({ inUse, status, freshStatus, whois });
});

export const layer = Layer.effect(TailscaleHost, make);
