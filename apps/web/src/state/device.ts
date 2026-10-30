import { useAtomValue } from "@effect/atom-react";
import { createDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/device";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type DeviceDetail,
  type DeviceServiceState,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "disabled",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
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

export function useDeviceHubAccess(
  environmentId: EnvironmentId | null,
  hostId = "local",
): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : deviceHubAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result)
    ? { ...result.value, query: { ...result.value.query, hostId } }
    : null;
}

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("device-hub-access:empty"),
);

export function refreshDeviceHubAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(deviceHubAccessAtom(environmentId));
}

/** Mints a fresh hub ticket for a one-off request that failed with 401. Resolves null on failure. */
export function renewDeviceHubAccess(
  environmentId: EnvironmentId,
  hostId = "local",
): Promise<DeviceHubAccess | null> {
  const atom = deviceHubAccessAtom(environmentId);
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.map((access) => ({ ...access, query: { ...access.query, hostId } })),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}

export interface DeviceDetailKey {
  readonly environmentId: EnvironmentId;
  readonly hostId: string;
  readonly deviceId: string;
}

export interface DeviceDetailView {
  /** Settings the host last confirmed, by a read or by an action's answer. */
  readonly detail: DeviceDetail | null;
  readonly error: string | null;
}

export const deviceDetailAtom = Atom.family((key: DeviceDetailKey) =>
  Atom.make<DeviceDetailView>({ detail: null, error: null }).pipe(
    Atom.withLabel(`device-detail:${key.hostId}:${key.deviceId}`),
  ),
);

/**
 * Reads a device's settings into its detail view while mounted. Reads and
 * actions share one serial lane per environment, so a read never answers
 * before an action that was sent ahead of it.
 */
export const deviceDetailReadAtom = Atom.family((key: DeviceDetailKey) =>
  Atom.make((get) =>
    Effect.promise(() =>
      runAtomCommand(
        get.registry,
        deviceEnvironment.detail,
        { environmentId: key.environmentId, input: { hostId: key.hostId, deviceId: key.deviceId } },
        { reportFailure: false },
      ),
    ).pipe(
      Effect.map((result) =>
        get.set(
          deviceDetailAtom(key),
          result._tag === "Success"
            ? { detail: result.value, error: null }
            : { detail: null, error: formatEnvironmentQueryError(result.cause) },
        ),
      ),
    ),
  ).pipe(Atom.withLabel(`device-detail-read:${key.hostId}:${key.deviceId}`)),
);

/**
 * Probes the environment's device hosts while mounted. Remote hosts report
 * their platforms only after a probe. Probing never installs or starts helpers.
 */
export const deviceHostProbeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Effect.promise(() =>
      runAtomCommand(
        get.registry,
        deviceEnvironment.list,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
    ).pipe(Effect.asVoid),
  ).pipe(Atom.withLabel(`device-host-probe:${environmentId}`)),
);

export const NO_DEVICE_PROBE_ATOM = Atom.make(AsyncResult.initial<void, never>()).pipe(
  Atom.withLabel("device-host-probe:none"),
);

/**
 * The Expo account an EAS host editor shows as it opens, for the saved
 * credential. Each open checks again; edits and manual checks use the command.
 */
export const deviceEasAccountCheck = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:device:eas-account-check",
  tag: WS_METHODS.deviceEasAccount,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

/** Who a Simlock token is, checked as the host editor's URL and token fields change. */
export const deviceSimlockIdentityCheck = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:device:simlock-identity-check",
    tag: WS_METHODS.deviceSimlockIdentity,
    staleTimeMs: 0,
    idleTtlMs: 0,
  },
);
