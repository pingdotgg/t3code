/**
 * RemoteOpenTargets - resolves the SSH hostnames this environment advertises
 * for remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`).
 *
 * The server can only check itself: sshd listening locally, tailscaled
 * reporting a MagicDNS name, and the machine hostname for mDNS. Whether a
 * given name resolves from the viewer's machine is inherently client-side.
 * Targets are ordered most-reachable first (tailnet name works from anywhere
 * on the tailnet; `<hostname>.local` only on the same LAN).
 *
 * Without sshd, Tailscale SSH can still serve the tailnet name. It answers
 * port 22 only for tailnet peers, so the loopback probe cannot see it; the
 * server asks tailscaled instead and advertises that one name.
 */
import { type RemoteOpenTarget, RemoteOpenUser } from "@t3tools/contracts";
import {
  HostProcessHostname,
  HostProcessPlatform,
  HostProcessUsername,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleSshEnabled, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const SSH_PORT = 22;

const isRemoteOpenUser = Schema.is(RemoteOpenUser);

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;

  // Tailscale absent or down is the common case, not an error.
  const readMagicDnsName = readTailscaleStatus.pipe(
    Effect.map((status) => status.magicDnsName),
    Effect.orElseSucceed(() => null),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  // Read on every config load, as the sshd path reads `tailscale status`.
  // Sharing one read across loads would hand a disconnecting client's
  // interruption to every load waiting on it.
  const resolveTailscaleSshTargets = Effect.gen(function* () {
    // Tailscale SSH has no Windows server, so skip the CLI there.
    if ((yield* HostProcessPlatform) === "win32") {
      return [];
    }
    // Ask both at once: each tailscale CLI start can take hundreds of
    // milliseconds, and config loads wait on this.
    const [sshEnabled, magicDnsName] = yield* Effect.all(
      [
        readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        readMagicDnsName,
      ],
      { concurrency: "unbounded" },
    );
    if (!sshEnabled || magicDnsName === null) {
      return [];
    }
    // Tailscale SSH signs in as the user the editor names, and editors
    // default to the viewing machine's username. Naming this process's
    // account opens the project as the user T3 Code runs as.
    const user = yield* HostProcessUsername;
    const target: RemoteOpenTarget =
      user !== undefined && isRemoteOpenUser(user)
        ? { kind: "tailscale-ssh", host: magicDnsName, user }
        : { kind: "tailscale-ssh", host: magicDnsName };
    return [target];
  });

  const resolveTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    // No local sshd leaves Tailscale SSH as the only possible route; with
    // neither, advertise nothing so clients render a clear "no SSH route"
    // state instead of links that hang.
    if (!sshdListening) {
      return yield* resolveTailscaleSshTargets;
    }

    const targets: Array<RemoteOpenTarget> = [];

    const magicDnsName = yield* readMagicDnsName;
    if (magicDnsName !== null) {
      targets.push({ kind: "tailscale", host: magicDnsName });
    }

    // os.hostname() may already be an FQDN (macOS often reports
    // "Name.local"); mDNS names are always `<first-label>.local`.
    const hostname = yield* HostProcessHostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({ kind: "mdns", host: `${shortHostname}.local` });
    }

    return targets;
  });

  return RemoteOpenTargets.of({ resolveTargets: () => resolveTargets });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
