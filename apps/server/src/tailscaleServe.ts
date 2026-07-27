import * as NetService from "@t3tools/shared/Net";
import {
  DEFAULT_TAILSCALE_SERVE_FALLBACK_PORTS,
  disableTailscaleServe,
  ensureTailscaleServe,
  loopbackProxyPorts,
  probeTailscaleServeEndpoint,
  readTailscaleServeConfig,
  resolveTailscaleExecutable,
  resolveTailscaleHttpsBaseUrl,
  selectTailscaleServePort,
  type TailscaleServeMount,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";

import * as TailnetAccess from "./tailnetAccess.ts";

/** What this process configured, so teardown only undoes its own mount. */
export interface TailscaleServeConfigured {
  readonly localPort: number;
  readonly servePort: number;
}

const describeConflicts = (mounts: ReadonlyArray<TailscaleServeMount>): ReadonlyArray<string> =>
  mounts.map(
    (mount) => `${mount.port} -> ${mount.proxyTargets.join(", ") || "(non-proxy handler)"}`,
  );

/**
 * Loopback ports referenced by the existing serve config that nothing is
 * listening on. Those mounts were left behind by a process that is gone — the
 * desktop app binds an ephemeral sidecar port, so a crash leaves a mount that
 * looks foreign on the next launch — and are safe to replace.
 */
const findStaleLoopbackPorts = Effect.fn("tailscaleServe.findStaleLoopbackPorts")(function* (
  mounts: ReadonlyArray<TailscaleServeMount>,
) {
  const net = yield* NetService.NetService;
  const stale = new Set<number>();
  for (const port of loopbackProxyPorts(mounts)) {
    if (yield* net.isPortAvailableOnLoopback(port)) {
      stale.add(port);
    }
  }
  return stale;
});

/**
 * Brings up Tailscale Serve for this server and records the tailnet base URL
 * clients should be handed — but only after verifying that the URL reaches
 * *this* environment.
 *
 * Every failure path records `null`, which makes the descriptor advertise no
 * tailnet endpoint and pairing fall back to the direct address. That is the
 * important invariant: a URL that is advertised but broken fails later, on
 * another device, with an error that points nowhere near the cause.
 */
export const configureTailscaleServe = Effect.fn("configureTailscaleServe")(function* (input: {
  readonly localPort: number;
  readonly preferredServePort: number;
  readonly environmentId: string;
}) {
  const tailnetAccess = yield* TailnetAccess.TailnetAccess;

  const executable = yield* resolveTailscaleExecutable;
  if (executable.source === "not-found") {
    yield* tailnetAccess.recordTailnetHttpsBaseUrl(null);
    yield* Effect.logWarning(
      "Tailscale CLI not found; not advertising a tailnet endpoint. Install Tailscale or set SERGECODE_TAILSCALE_CLI to its path.",
      { searchedCommand: executable.command },
    );
    return null;
  }

  const mounts = yield* readTailscaleServeConfig;
  const staleLoopbackPorts = yield* findStaleLoopbackPorts(mounts);
  const servePort = selectTailscaleServePort({
    preferredPort: input.preferredServePort,
    fallbackPorts: DEFAULT_TAILSCALE_SERVE_FALLBACK_PORTS,
    localPort: input.localPort,
    mounts,
    isStaleLoopbackPort: (port) => staleLoopbackPorts.has(port),
  });
  if (servePort === null) {
    yield* tailnetAccess.recordTailnetHttpsBaseUrl(null);
    yield* Effect.logWarning(
      "Every candidate Tailscale Serve port is already used by another service on this node; not advertising a tailnet endpoint.",
      {
        preferredServePort: input.preferredServePort,
        fallbackServePorts: DEFAULT_TAILSCALE_SERVE_FALLBACK_PORTS,
        existingMounts: describeConflicts(mounts),
      },
    );
    return null;
  }

  yield* ensureTailscaleServe({
    localPort: input.localPort,
    servePort,
    localHost: "127.0.0.1",
  });
  const configured: TailscaleServeConfigured = { localPort: input.localPort, servePort };

  const tailnetHttpsBaseUrl = yield* resolveTailscaleHttpsBaseUrl({ servePort }).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (tailnetHttpsBaseUrl === null) {
    yield* tailnetAccess.recordTailnetHttpsBaseUrl(null);
    yield* Effect.logWarning(
      "Tailscale Serve is configured but this node has no MagicDNS name; not advertising a tailnet endpoint.",
      { localPort: input.localPort, servePort },
    );
    return configured;
  }

  const probe = yield* probeTailscaleServeEndpoint({
    baseUrl: tailnetHttpsBaseUrl,
    expectedEnvironmentId: input.environmentId,
  });
  if (!probe.ok) {
    yield* tailnetAccess.recordTailnetHttpsBaseUrl(null);
    yield* Effect.logWarning(
      "Tailscale Serve endpoint did not answer as this environment; not advertising a tailnet endpoint.",
      {
        tailnetHttpsBaseUrl,
        localPort: input.localPort,
        servePort,
        reason: probe.reason,
        ...("status" in probe ? { status: probe.status } : {}),
        ...("environmentId" in probe ? { respondingEnvironmentId: probe.environmentId } : {}),
      },
    );
    return configured;
  }

  yield* tailnetAccess.recordTailnetHttpsBaseUrl(tailnetHttpsBaseUrl);
  yield* Effect.logInfo("Tailscale Serve configured", {
    localPort: input.localPort,
    servePort,
    tailnetHttpsBaseUrl,
    tailscaleCli: executable.command,
    tailscaleCliSource: executable.source,
  });
  return configured;
});

export const teardownTailscaleServe = (configured: TailscaleServeConfigured | null) =>
  configured === null
    ? Effect.void
    : disableTailscaleServe({ servePort: configured.servePort }).pipe(
        Effect.tap(() =>
          Effect.logInfo("Tailscale Serve disabled", { servePort: configured.servePort }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to disable Tailscale Serve", {
            cause,
            servePort: configured.servePort,
          }),
        ),
      );
