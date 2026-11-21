import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { createPrinterEnvironmentAtoms } from "@t3tools/client-runtime/state/printer";
import {
  type EnvironmentId,
  PRINTER_MEDIA_ROUTE_PREFIX,
  type PrinterServiceState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMessages } from "gt-react";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironments } from "./environments";
import {
  collectFleetPrinters,
  type FleetPrinterEntry,
  type FleetPrinterEnvironmentSource,
  selectFleetPrinter,
} from "./printerFleet";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export {
  selectFleetPrinter,
  type FleetPrinterEntry,
  type FleetPrinterEnvironmentSource,
} from "./printerFleet";

export const printerEnvironment = createPrinterEnvironmentAtoms(connectionAtomRuntime);

const MEDIA_TICKET_REFRESH_INTERVAL_MS = 210_000;
const MEDIA_TICKET_RETRY_INTERVAL_MS = 15_000;

const EMPTY_PRINTER_STATE: PrinterServiceState = {
  enabled: false,
  agentAccessEnabled: false,
  mediaBasePath: PRINTER_MEDIA_ROUTE_PREFIX,
  printers: [],
  sessions: [],
  revision: 0,
};

const connectedPrinterStatesAtom = environmentAtomList("printer:states", (environmentId) =>
  printerEnvironment.state({ environmentId, input: {} }),
);

export function usePrinterState(environmentId: EnvironmentId | null): {
  readonly state: PrinterServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null ? null : printerEnvironment.state({ environmentId, input: {} }),
    resolve,
  );
  return {
    state: query.data ?? EMPTY_PRINTER_STATE,
    loaded: query.data !== null,
    error: query.error,
    refresh: query.refresh,
  };
}

/**
 * Discovers 3D printers across all connected T3 Connect environments so any thread
 * on any machine in the fleet can seamlessly route through whichever environment
 * has network access to the printer.
 */
export function useFleetPrinters(threadEnvironmentId: EnvironmentId | null): {
  readonly entries: ReadonlyArray<FleetPrinterEntry>;
  readonly localState: PrinterServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly loadingEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly unreachableEnvironmentCount: number;
} {
  const resolve = useMessages();
  const { environments } = useEnvironments();
  const connected = environments.filter((env) => env.connection.phase === "connected");

  const envIds: Array<EnvironmentId> = [];
  const envMeta = new Map<
    EnvironmentId,
    { readonly label: string; readonly relayManaged: boolean }
  >();
  if (threadEnvironmentId !== null) {
    const match = environments.find((env) => env.environmentId === threadEnvironmentId);
    envIds.push(threadEnvironmentId);
    envMeta.set(threadEnvironmentId, {
      label: match?.label ?? threadEnvironmentId,
      relayManaged: match?.relayManaged ?? false,
    });
  }
  for (const env of connected) {
    if (envMeta.has(env.environmentId)) continue;
    envIds.push(env.environmentId);
    envMeta.set(env.environmentId, {
      label: env.label,
      relayManaged: env.relayManaged,
    });
  }

  const results = useAtomValue(connectedPrinterStatesAtom(environmentIdsKey(envIds)));
  const sources: Array<FleetPrinterEnvironmentSource> = [];
  let localState = EMPTY_PRINTER_STATE;
  let localLoaded = threadEnvironmentId === null;
  let localError: string | null = null;
  let settledCount = 0;
  let unreachableEnvironmentCount = 0;
  const loadingEnvironmentIds = new Set<EnvironmentId>();

  for (const env of environments) {
    if (
      envMeta.has(env.environmentId) &&
      (env.connection.phase === "connecting" || env.connection.phase === "reconnecting")
    ) {
      loadingEnvironmentIds.add(env.environmentId);
    }
  }

  for (let index = 0; index < envIds.length; index += 1) {
    const environmentId = envIds[index]!;
    const result = results[index];
    const meta = envMeta.get(environmentId)!;
    const data = result && AsyncResult.isSuccess(result) ? result.value : null;
    const failed = result !== undefined && AsyncResult.isFailure(result);
    if (data !== null || failed) {
      settledCount += 1;
      loadingEnvironmentIds.delete(environmentId);
    } else {
      loadingEnvironmentIds.add(environmentId);
    }
    if (failed) {
      unreachableEnvironmentCount += 1;
    }
    sources.push({
      environmentId,
      label: meta.label,
      relayManaged: meta.relayManaged,
      state: data,
    });
    if (environmentId === threadEnvironmentId) {
      if (data !== null) {
        localState = data;
        localLoaded = true;
      } else if (failed) {
        localLoaded = true;
        localError = formatEnvironmentQueryError(result.cause, resolve);
      }
    }
  }

  const entries = collectFleetPrinters(sources, threadEnvironmentId);
  const loaded = entries.length > 0 || localLoaded || settledCount > 0;

  return {
    entries,
    localState,
    loaded,
    error: entries.length === 0 ? localError : null,
    loadingEnvironmentIds,
    unreachableEnvironmentCount,
  };
}

const printerMediaAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({
        prepared,
        hubBasePath: EMPTY_PRINTER_STATE.mediaBasePath,
      });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`printer-media-access:${environmentId}`)),
);

const EMPTY_MEDIA_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("printer-media-access:empty"),
);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(
  Option.none<{ readonly httpAuthorization: unknown }>(),
).pipe(Atom.withLabel("printer-media-prepared:empty"));

export function usePrinterMediaAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_MEDIA_ACCESS_ATOM : printerMediaAccessAtom(environmentId),
  );
  const prepared = useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const access = AsyncResult.isSuccess(result) ? result.value : null;
  const failed = AsyncResult.isFailure(result);
  // Keep renewal active whenever the environment uses bearer/DPoP media tickets, even after a transient refresh failure.
  const usesMediaTicket = Option.isSome(prepared) && prepared.value.httpAuthorization !== null;

  // Proactively renew 5-minute media wsTickets on long-lived T3 Connect sessions before expiry.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules periodic renewal of short-lived media wsTickets for remote/T3 Connect environments while mounted
  useEffect(() => {
    if (environmentId === null || !usesMediaTicket) return;
    const intervalMs = failed ? MEDIA_TICKET_RETRY_INTERVAL_MS : MEDIA_TICKET_REFRESH_INTERVAL_MS;
    const timer = window.setInterval(() => {
      refreshPrinterMediaAccess(environmentId);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [environmentId, usesMediaTicket, failed]);

  return access;
}

export function refreshPrinterMediaAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(printerMediaAccessAtom(environmentId));
}

export function buildPrinterMediaUrl(
  access: DeviceHubAccess | null,
  printerId: string,
  asset: "camera" | "cover" | "pick",
  cacheKey: string | number,
): string | null {
  if (!access) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(access.query)) {
    if (value !== undefined) params.set(key, value);
  }
  params.set("v", String(cacheKey));
  const base = access.httpBase.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(printerId)}/${asset}?${params.toString()}`;
}

export function useResolvedFleetPrinter(
  threadEnvironmentId: EnvironmentId | null,
  printerId?: string,
  proxyEnvironmentId?: EnvironmentId,
): FleetPrinterEntry | undefined {
  const { entries } = useFleetPrinters(threadEnvironmentId);
  return selectFleetPrinter(entries, printerId, proxyEnvironmentId);
}
