import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SCUTIL_TIMEOUT = Duration.seconds(1);
const CACHE_TTL = Duration.minutes(5);

// hostname() may be an FQDN; mDNS always uses <first-label>.local.
export const mdnsHostFromName = (name: string): string | null => {
  const label = name.split(".")[0]?.trim();
  return label ? `${label}.local` : null;
};

// Bonjour answers to LocalHostName, which can differ from a hostname() assigned by DHCP.
const readLocalHostName = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make("/usr/sbin/scutil", ["--get", "LocalHostName"], {
      forceKillAfter: SCUTIL_TIMEOUT,
    }),
  );
}).pipe(
  Effect.timeout(SCUTIL_TIMEOUT),
  Effect.catchCause(() => Effect.succeed("")),
);

export const resolveMdnsHost = Effect.fn("mdnsHost.resolve")(function* () {
  const platform = yield* HostProcess.Platform;
  const localHostName = platform === "darwin" ? yield* readLocalHostName : "";
  return mdnsHostFromName(localHostName) ?? mdnsHostFromName(yield* HostProcess.Hostname);
});

// Expires so a failed scutil lookup is retried and a rename is picked up without a restart.
export const makeCachedMdnsHost = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.cachedWithTTL(
    resolveMdnsHost().pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    CACHE_TTL,
  );
});
