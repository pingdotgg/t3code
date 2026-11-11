import type {
  EnvironmentId,
  TailnetDeviceClientCredential,
  TailnetDeviceOpenInput,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type NetworkMemberRecord,
  type NetworkMemberRenewal,
  type NetworkRosterReport,
  NetworkMembers,
  followNetworkRoster,
  followedNetwork,
  makeNetworkMemberRenewals,
  openNetworkMember,
} from "../connection/networkMembers.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { offersLinkedEnvironments } from "../linkRequest.ts";
import {
  type AtomCommand,
  createAtomCommandScheduler,
  createRuntimeCommand,
  environmentSessionGenerationAtom,
} from "./runtime.ts";

type OpenDeviceTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: TailnetDeviceOpenInput;
};

/** Keeps the previous array while its items are the same, so readers see no change. */
function reuseSame<A>(
  previous: Option.Option<ReadonlyArray<A>>,
  next: ReadonlyArray<A>,
  same: (left: A, right: A) => boolean,
): ReadonlyArray<A> {
  if (Option.isNone(previous)) return next;
  const value = previous.value;
  return value.length === next.length && value.every((item, index) => same(item, next[index]!))
    ? value
    : next;
}

/**
 * Follows the user's network live from every member this client is connected to: members it
 * lacks become records, opened only on demand through `tailnetDevices.openDevice`.
 */
export function createNetworkMemberAtoms<R, E, EO>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | ConnectionOnboarding.ConnectionOnboarding | R,
    E
  >,
  options: {
    readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
    readonly tailnetDevices: {
      readonly snapshot: (target: {
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
  const renewals = makeNetworkMemberRenewals();
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

  /** The live roster of every connected member that offers the network and may open devices. */
  const reportsAtom = Atom.make((get): ReadonlyArray<NetworkRosterReport> => {
    const reports: Array<NetworkRosterReport> = [];
    for (const [host, presentation] of get(options.presentationsAtom)) {
      if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
        continue;
      }
      if (!offersLinkedEnvironments(presentation.serverConfig)) continue;
      if (!get(options.tailnetDevices.openDevice.permissionAtom(host))) continue;
      const snapshot = get(options.tailnetDevices.snapshot({ environmentId: host, input: {} }));
      if (AsyncResult.isSuccess(snapshot)) reports.push({ host, roster: snapshot.value });
    }
    return reuseSame(
      get.self<ReadonlyArray<NetworkRosterReport>>(),
      reports,
      (left, right) => left.host === right.host && left.roster === right.roster,
    );
  }).pipe(Atom.withLabel("network-members:reports"));

  /** Connected hosts of the network this client follows: the only ones asked to open a member. */
  const followedHostsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> =>
    reuseSame(
      get.self<ReadonlyArray<EnvironmentId>>(),
      followedNetwork(get(recordsAtom), get(reportsAtom)).reports.map((report) => report.host),
      (left, right) => left === right,
    ),
  ).pipe(Atom.withLabel("network-members:followed-hosts"));

  const renewalsAtom = Atom.make((get): ReadonlyArray<NetworkMemberRenewal> => {
    const presentations = get(options.presentationsAtom);
    const hosts = get(followedHostsAtom);
    const hostsKey = [...hosts].sort().join(",");
    const due =
      hosts.length === 0
        ? []
        : get(recordsAtom).flatMap((record) =>
            presentations.get(record.environmentId)?.connection.needsPairing === true
              ? [
                  {
                    environmentId: record.environmentId,
                    // A new session on the member means the last renewal worked for a while.
                    attemptKey: `${hostsKey}|${get(environmentSessionGenerationAtom(runtime, record.environmentId))}`,
                  },
                ]
              : [],
          );
    return reuseSame(
      get.self<ReadonlyArray<NetworkMemberRenewal>>(),
      due,
      (left, right) =>
        left.environmentId === right.environmentId && left.attemptKey === right.attemptKey,
    );
  }).pipe(Atom.withLabel("network-members:renewals"));

  const follow = createRuntimeCommand(runtime, {
    label: "network-members:follow",
    scheduler,
    concurrency: { mode: "latest", key: () => "network-members" },
    execute: Effect.fn("NetworkMembers.followReports")(function* (
      reports: ReadonlyArray<NetworkRosterReport>,
    ) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* followNetworkRoster({
        reports,
        savedEnvironmentIds: SubscriptionRef.get(registry.entries).pipe(
          Effect.map((entries): ReadonlySet<EnvironmentId> => new Set(entries.keys())),
        ),
        forget: registry.remove,
      });
    }),
  });

  const openMember = Effect.fn("NetworkMembers.openMember")(function* (
    environmentId: EnvironmentId,
    atomRegistry: AtomRegistry.AtomRegistry,
  ) {
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    return yield* openNetworkMember({
      environmentId,
      hosts: atomRegistry.get(followedHostsAtom),
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
  });

  const open = createRuntimeCommand(runtime, {
    label: "network-members:open",
    scheduler,
    concurrency: { mode: "singleFlight", key: (environmentId: EnvironmentId) => environmentId },
    execute: openMember,
  });

  const renew = createRuntimeCommand(runtime, {
    label: "network-members:renew",
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: (renewal: NetworkMemberRenewal) => renewal.environmentId,
    },
    execute: (renewal: NetworkMemberRenewal, atomRegistry: AtomRegistry.AtomRegistry) =>
      renewals.renew(renewal, openMember(renewal.environmentId, atomRegistry)),
  });

  return {
    recordsAtom,
    unopenedAtom,
    reportsAtom,
    followedHostsAtom,
    renewalsAtom,
    follow,
    open,
    renew,
  };
}
