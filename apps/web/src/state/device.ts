import { useAtomValue } from "@effect/atom-react";
import { createDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/device";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";
import { useEnvironmentQuery } from "./query";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  devices: [],
  sessions: [],
  hubBasePath: "/api/device-hub",
  revision: 0,
};

export function useDeviceState(environmentId: EnvironmentId | null): {
  readonly state: DeviceServiceState;
  readonly loaded: boolean;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : deviceEnvironment.state({ environmentId, input: {} }),
  );
  return { state: query.data ?? EMPTY_DEVICE_STATE, loaded: query.data !== undefined };
}

/**
 * Hub access for one environment. Bearer and DPoP connections mint a ticket
 * here; a stream that gets a 401 back refreshes this atom and reconnects.
 * Keyed on the prepared connection so a re-pair produces new credentials.
 */
const deviceHubAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: EMPTY_DEVICE_STATE.hubBasePath });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`device-hub-access:${environmentId}`)),
);

export function useDeviceHubAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : deviceHubAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("device-hub-access:empty"),
);

export function refreshDeviceHubAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(deviceHubAccessAtom(environmentId));
}
