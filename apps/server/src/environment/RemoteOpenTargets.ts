import { type RemoteOpenTarget } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleSshEnabled, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeStaleWhileRevalidate } from "./staleWhileRevalidate.ts";

const SSH_PORT = 22;
const TARGETS_CACHE_TTL = "60 seconds";

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;

  const discoverTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    const username = yield* HostProcess.Username;

    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // Tailscale SSH needs no local sshd; tailscaled alone does not prove an SSH route.
      if (
        magicDnsName !== null &&
        (yield* readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ))
      ) {
        targets.push({
          kind: "tailscale",
          host: magicDnsName,
          ...(username === null ? {} : { username }),
        });
      }
      return targets;
    }

    if (magicDnsName !== null) {
      targets.push({
        kind: "tailscale",
        host: magicDnsName,
        ...(username === null ? {} : { username }),
      });
    }

    // hostname() may be an FQDN; mDNS always uses <first-label>.local.
    const hostname = yield* HostProcess.Hostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({
        kind: "mdns",
        host: `${shortHostname}.local`,
        ...(username === null ? {} : { username }),
      });
    }

    return targets;
  });

  // Advertised on every client connect; probing sshd and tailscaled is slow
  // on a loaded host, so serve the last result while it refreshes.
  const resolveTargets = yield* makeStaleWhileRevalidate(discoverTargets, TARGETS_CACHE_TTL);

  return RemoteOpenTargets.of({
    resolveTargets: Effect.fn("RemoteOpenTargets.resolveTargets")(function () {
      return resolveTargets;
    }),
  });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
