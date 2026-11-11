import {
  type EnvironmentId,
  type PeerLinkSummary,
  type TailnetDevicesSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type DeviceNetworkHost, isTailnetDevicesForbidden } from "../tailnetDevices.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** The Device network writes added with leaving and local limits; snapshots follow them live. */
export function createDeviceNetworkCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    forget: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:forget",
      tag: WS_METHODS.tailnetDevicesForget,
    }),
    forgetApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:forget-app",
      tag: WS_METHODS.tailnetDevicesForgetApp,
    }),
    setLimit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:set-limit",
      tag: WS_METHODS.tailnetDevicesSetLimit,
    }),
    leave: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:leave",
      tag: WS_METHODS.tailnetDevicesLeave,
    }),
    allowJoin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:allow-join",
      tag: WS_METHODS.tailnetDevicesAllowJoin,
    }),
  };
}

type ListFamily<A> = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: Record<string, never>;
}) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;

/** A connected environment that offers the network, and its own switch. */
export interface DeviceNetworkHostInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly enabled: boolean;
}

export interface DeviceNetworkHostState extends DeviceNetworkHost {
  /** Unavailable: the host cannot list devices yet (an older server). */
  readonly list: "loading" | "ready" | "unavailable" | "forbidden";
}

/**
 * Every host's snapshot, links and permissions, read together so one view can merge them.
 * Keyed by `deviceNetworkHostsKey`, so a new host list is a new atom.
 */
export function createDeviceNetworkHostsAtom(options: {
  readonly snapshot: ListFamily<TailnetDevicesSnapshot>;
  readonly links: ListFamily<{ readonly links: ReadonlyArray<PeerLinkSummary> }>;
  readonly mayWrite: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ReadonlyArray<DeviceNetworkHostState> =>
      (JSON.parse(key) as ReadonlyArray<DeviceNetworkHostInput>).map((host) => {
        const target = { environmentId: host.environmentId, input: {} };
        const snapshot = get(options.snapshot(target));
        const failure = AsyncResult.isFailure(snapshot)
          ? Option.getOrNull(Cause.findErrorOption(snapshot.cause))
          : null;
        return {
          ...host,
          snapshot: AsyncResult.getOrElse(snapshot, () => null),
          links: AsyncResult.getOrElse(get(options.links(target)), () => null)?.links ?? [],
          mayWrite: get(options.mayWrite(host.environmentId)),
          list: AsyncResult.isSuccess(snapshot)
            ? "ready"
            : AsyncResult.isFailure(snapshot)
              ? isTailnetDevicesForbidden(failure)
                ? "forbidden"
                : "unavailable"
              : "loading",
        };
      }),
    ).pipe(Atom.withLabel(`device-network:hosts:${key}`)),
  );
}

export const deviceNetworkHostsKey = (hosts: ReadonlyArray<DeviceNetworkHostInput>) =>
  JSON.stringify(
    hosts.map(({ environmentId, label, enabled }) => ({ environmentId, label, enabled })),
  );

/** After a write, every host's links; snapshots are pushed, but links are only listed. */
export function refreshDeviceNetwork(
  registry: { readonly refresh: (atom: Atom.Atom<unknown>) => void },
  links: ListFamily<unknown>,
  hosts: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
) {
  for (const { environmentId } of hosts) registry.refresh(links({ environmentId, input: {} }));
}
