import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { createPrinterEnvironmentAtoms } from "@t3tools/client-runtime/state/printer";
import type { EnvironmentId, PrinterServiceState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const printerEnvironment = createPrinterEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_PRINTER_STATE: PrinterServiceState = {
  enabled: false,
  agentAccessEnabled: false,
  mediaBasePath: "/api/printer-media",
  printers: [],
  sessions: [],
  revision: 0,
};

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

export function usePrinterMediaAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_MEDIA_ACCESS_ATOM : printerMediaAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
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
