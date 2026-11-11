import type {
  EnvironmentId,
  TailnetDeviceClientCredential,
  TailnetDeviceOpenInput,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type NetworkMemberRecord,
  type NetworkRoster,
  NetworkMembers,
  followNetworkRoster,
  openNetworkMember,
} from "../connection/networkMembers.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { offersLinkedEnvironments } from "../linkRequest.ts";
import { type AtomCommand, createAtomCommandScheduler, createRuntimeCommand } from "./runtime.ts";

type OpenDeviceTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: TailnetDeviceOpenInput;
};

/** What one connected member said about the network, ready for `follow`. */
export interface NetworkRosterReport {
  readonly host: EnvironmentId;
  /** Null when the member does not offer the network, which drops what it brought. */
  readonly roster: NetworkRoster | null;
}

/** A managed member to open again because its host refused the saved credential. */
export interface NetworkMemberRenewal {
  readonly environmentId: EnvironmentId;
  /** Changes when another member connects, which is when a failed renewal is worth retrying. */
  readonly attemptKey: string;
}

/**
 * Follows the user's network from every member this client is connected to: members it lacks
 * become records, opened only on demand through `tailnetDevices.openDevice`.
 */
export function createNetworkMemberAtoms<R, E, EO>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | ConnectionOnboarding.ConnectionOnboarding | R,
    E
  >,
  options: {
    readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
    readonly tailnetDevices: {
      readonly list: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: Record<string, never>;
      }) => Atom.Atom<AsyncResult.AsyncResult<TailnetDevicesSnapshot, unknown>>;
      readonly openDevice: AtomCommand<OpenDeviceTarget, TailnetDeviceClientCredential, EO> & {
        readonly permissionAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
      };
    };
  },
) {
  const scheduler = createAtomCommandScheduler();
  const recordsResultAtom = runtime.atom(
    Stream.unwrap(NetworkMembers.pipe(Effect.map((members) => members.changes))),
    { initialValue: [] as ReadonlyArray<NetworkMemberRecord> },
  );
  const recordsAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(recordsResultAtom), () => []),
  ).pipe(Atom.withLabel("network-members:records"));

  /** Members of the network this client has not opened yet. */
  const unopenedAtom = Atom.make((get) => {
    const presentations = get(options.presentationsAtom);
    return get(recordsAtom).filter((record) => !presentations.has(record.environmentId));
  }).pipe(Atom.withLabel("network-members:unopened"));

  const reportsAtom = Atom.make((get): ReadonlyArray<NetworkRosterReport> => {
    const reports: Array<NetworkRosterReport> = [];
    for (const [host, presentation] of get(options.presentationsAtom)) {
      if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
        continue;
      }
      if (!offersLinkedEnvironments(presentation.serverConfig)) {
        reports.push({ host, roster: null });
        continue;
      }
      // Only a member that may open devices for this client is worth following.
      if (!get(options.tailnetDevices.openDevice.permissionAtom(host))) continue;
      const snapshot = get(options.tailnetDevices.list({ environmentId: host, input: {} }));
      if (AsyncResult.isSuccess(snapshot)) reports.push({ host, roster: snapshot.value });
    }
    return reports;
  }).pipe(Atom.withLabel("network-members:reports"));

  const renewalsAtom = Atom.make((get): ReadonlyArray<NetworkMemberRenewal> => {
    const presentations = get(options.presentationsAtom);
    const connected = [...presentations]
      .flatMap(([id, presentation]) => (presentation.connection.phase === "connected" ? [id] : []))
      .sort()
      .join(",");
    return get(recordsAtom).flatMap((record) =>
      presentations.get(record.environmentId)?.connection.needsPairing === true
        ? [{ environmentId: record.environmentId, attemptKey: connected }]
        : [],
    );
  }).pipe(Atom.withLabel("network-members:renewals"));

  const follow = createRuntimeCommand(runtime, {
    label: "network-members:follow",
    scheduler,
    concurrency: { mode: "serial", key: () => "network-members" },
    execute: Effect.fn("NetworkMembers.followReport")(function* (report: NetworkRosterReport) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* followNetworkRoster({
        host: report.host,
        roster: report.roster,
        savedEnvironmentIds: new Set((yield* SubscriptionRef.get(registry.entries)).keys()),
        forget: registry.remove,
      });
    }),
  });

  const open = createRuntimeCommand(runtime, {
    label: "network-members:open",
    scheduler,
    concurrency: { mode: "singleFlight", key: (environmentId: EnvironmentId) => environmentId },
    execute: Effect.fn("NetworkMembers.openMember")(function* (
      environmentId: EnvironmentId,
      atomRegistry: AtomRegistry.AtomRegistry,
    ) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
      const connected = new Set<EnvironmentId>();
      for (const id of (yield* SubscriptionRef.get(registry.entries)).keys()) {
        const state = yield* registry.state(id).pipe(Effect.option);
        if (state._tag === "Some" && state.value.phase === "connected") connected.add(id);
      }
      return yield* openNetworkMember({
        environmentId,
        connectedEnvironmentIds: connected,
        mint: (via, target) =>
          Effect.promise(() =>
            options.tailnetDevices.openDevice.run(atomRegistry, {
              environmentId: via,
              input: { environmentId: target },
            }),
          ).pipe(
            Effect.flatMap((result) =>
              AsyncResult.isSuccess(result)
                ? Effect.succeed(result.value)
                : Effect.failCause(result.cause),
            ),
          ),
        register: onboarding.registerDevice,
      });
    }),
  });

  return { recordsAtom, unopenedAtom, reportsAtom, renewalsAtom, follow, open };
}
