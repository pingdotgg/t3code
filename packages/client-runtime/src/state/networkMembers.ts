import type {
  EnvironmentId,
  TailnetDeviceClientCredential,
  TailnetDeviceOpenInput,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type NetworkMemberAttempt,
  type NetworkMemberRecord,
  type NetworkMemberRenewal,
  type NetworkRosterReport,
  NetworkMembers,
  type SavedEnvironmentState,
  dueNetworkMemberOpens,
  followNetworkRoster,
  followedNetworks,
  makeNetworkMemberRenewals,
  openNetworkMember,
  type OpeningHost,
  networkMemberStatus,
  openingHosts,
  unboundMembers,
} from "../connection/networkMembers.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
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

/** What a failed open says about why, when it says anything. */
function failureReason(cause: Cause.Cause<unknown>): string | null {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim() !== "" ? error.message : null;
}

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
 * lacks become records, opened without a click through `tailnetDevices.openDevice` unless the
 * user switched them off here.
 */
export function createNetworkMemberAtoms<R, E, EO>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | ConnectionOnboarding.ConnectionOnboarding
    | HttpClient.HttpClient
    | R,
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
      /** A session without an app id opens members only where it may write the network. */
      readonly setAccess: {
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

  /** The live roster of every connected member that offers the network and may open devices. */
  const reportsAtom = Atom.make((get): ReadonlyArray<NetworkRosterReport> => {
    const reports: Array<NetworkRosterReport> = [];
    for (const [host, presentation] of get(options.presentationsAtom)) {
      if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
        continue;
      }
      if (!offersLinkedEnvironments(presentation.serverConfig)) continue;
      if (
        !get(options.tailnetDevices.openDevice.permissionAtom(host)) &&
        !get(options.tailnetDevices.setAccess.permissionAtom(host))
      ) {
        continue;
      }
      const snapshot = get(options.tailnetDevices.snapshot({ environmentId: host, input: {} }));
      if (AsyncResult.isSuccess(snapshot)) reports.push({ host, roster: snapshot.value });
    }
    return reuseSame(
      get.self<ReadonlyArray<NetworkRosterReport>>(),
      reports,
      (left, right) => left.host === right.host && left.roster === right.roster,
    );
  }).pipe(Atom.withLabel("network-members:reports"));

  /** Members not saved here whose addresses did not answer on the last attempt. */
  const unreachableAtom = Atom.make<{ readonly ids: ReadonlySet<EnvironmentId> }>({
    ids: new Set<EnvironmentId>(),
  }).pipe(Atom.keepAlive, Atom.withLabel("network-members:unreachable"));

  /** The last open of each member, until one succeeds. */
  const attemptsAtom = Atom.make<{
    readonly byId: ReadonlyMap<EnvironmentId, NetworkMemberAttempt>;
  }>({ byId: new Map() }).pipe(Atom.keepAlive, Atom.withLabel("network-members:attempts"));

  /** A connected host has agent links paused, so it takes no part in opening members. */
  const pausedAtom = Atom.make((get) => {
    for (const presentation of get(options.presentationsAtom).values()) {
      const config = presentation.serverConfig;
      if (presentation.connection.phase !== "connected" || config === null) continue;
      if (config.environment.capabilities.peerLinks === true && !offersLinkedEnvironments(config)) {
        return true;
      }
    }
    return false;
  }).pipe(Atom.withLabel("network-members:paused"));

  /** Members of the network this client has not opened yet and some machine can open. */
  const unopenedAtom = Atom.make((get) => {
    const presentations = get(options.presentationsAtom);
    const unbound = unboundMembers(get(reportsAtom));
    return get(recordsAtom).filter(
      (record) =>
        record.left !== true &&
        !presentations.has(record.environmentId) &&
        !unbound.has(record.environmentId),
    );
  }).pipe(Atom.withLabel("network-members:unopened"));

  /** Connected hosts of the networks this client follows. */
  const followedHostsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> =>
    reuseSame(
      get.self<ReadonlyArray<EnvironmentId>>(),
      followedNetworks(get(reportsAtom)).flatMap((network) =>
        network.reports.map((report) => report.host),
      ),
      (left, right) => left === right,
    ),
  ).pipe(Atom.withLabel("network-members:followed-hosts"));

  /** The connected hosts asked to open a member, in the order they are asked. */
  const openingHostsAtom = Atom.make((get): ReadonlyArray<OpeningHost> =>
    reuseSame(
      get.self<ReadonlyArray<OpeningHost>>(),
      openingHosts(get(reportsAtom), (host) =>
        get(options.tailnetDevices.setAccess.permissionAtom(host)),
      ),
      (left, right) => left.host === right.host && left.appId === right.appId,
    ),
  ).pipe(Atom.withLabel("network-members:opening-hosts"));

  /** Members to open now: not saved here yet, or refused (`dueNetworkMemberOpens`). */
  const dueOpensAtom = Atom.make((get): ReadonlyArray<NetworkMemberRenewal> => {
    const saved = new Map<EnvironmentId, SavedEnvironmentState>();
    for (const [environmentId, presentation] of get(options.presentationsAtom)) {
      saved.set(environmentId, {
        needsPairing: presentation.connection.needsPairing === true,
        enabled: presentation.entry.enabled,
      });
    }
    const due = dueNetworkMemberOpens({
      records: get(recordsAtom),
      reports: get(reportsAtom),
      hosts: get(openingHostsAtom),
      saved,
      // A new session on the member means the last open worked for a while.
      generation: (environmentId) => get(environmentSessionGenerationAtom(runtime, environmentId)),
    });
    return reuseSame(
      get.self<ReadonlyArray<NetworkMemberRenewal>>(),
      due,
      (left, right) =>
        left.environmentId === right.environmentId && left.attemptKey === right.attemptKey,
    );
  }).pipe(Atom.withLabel("network-members:due-opens"));

  /** Each record and the one status the UI shows for it (`networkMemberStatus`). */
  const statusAtom = Atom.make((get) => {
    const presentations = get(options.presentationsAtom);
    const openers = get(openingHostsAtom);
    const unreachable = get(unreachableAtom).ids;
    const attempts = get(attemptsAtom).byId;
    const due = new Set(get(dueOpensAtom).map((renewal) => renewal.environmentId));
    const paused = get(pausedAtom);
    return new Map(
      get(recordsAtom).map((record) => {
        const saved = presentations.get(record.environmentId);
        return [
          record.environmentId,
          {
            record,
            ...networkMemberStatus({
              record,
              saved:
                saved === undefined
                  ? undefined
                  : { needsPairing: saved.connection.needsPairing === true },
              canOpen: openers.some((opener) => opener.host !== record.environmentId),
              unreachable: unreachable.has(record.environmentId),
              due: due.has(record.environmentId),
              attempt: attempts.get(record.environmentId),
              paused,
            }),
          },
        ] as const;
      }),
    );
  }).pipe(Atom.withLabel("network-members:status"));

  const follow = createRuntimeCommand(runtime, {
    label: "network-members:follow",
    scheduler,
    concurrency: { mode: "latest", key: () => "network-members" },
    execute: Effect.fn("NetworkMembers.followReports")(function* (
      reports: ReadonlyArray<NetworkRosterReport>,
      atomRegistry: AtomRegistry.AtomRegistry,
    ) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* followNetworkRoster({
        reports,
        savedEnvironmentIds: SubscriptionRef.get(registry.entries).pipe(
          Effect.map((entries): ReadonlySet<EnvironmentId> => new Set(entries.keys())),
        ),
        forget: registry.remove,
        mayWrite: (host) => atomRegistry.get(options.tailnetDevices.setAccess.permissionAtom(host)),
      });
    }),
  });

  const openMember = Effect.fn("NetworkMembers.openMember")(function* (
    environmentId: EnvironmentId,
    atomRegistry: AtomRegistry.AtomRegistry,
  ) {
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const listings = atomRegistry
      .get(reportsAtom)
      .flatMap((report) => report.roster.devices)
      .filter((device) => device.environmentId === environmentId);
    const urls = [...new Set(listings.flatMap((device) => device.urls))];
    const markUnreachable = (unreachable: boolean) =>
      Effect.sync(() => {
        const current = atomRegistry.get(unreachableAtom).ids;
        if (current.has(environmentId) === unreachable) return;
        const next = new Set(current);
        if (unreachable) next.add(environmentId);
        else next.delete(environmentId);
        atomRegistry.set(unreachableAtom, { ids: next });
      });
    // An offline or unreachable member costs no server-to-server call and no credential.
    const reachable =
      urls.length === 0
        ? Effect.succeed(true)
        : Effect.findFirst(urls, (url) =>
            fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url }).pipe(
              Effect.map((descriptor) => descriptor.environmentId === environmentId),
              Effect.orElseSucceed(() => false),
            ),
          ).pipe(
            Effect.map(Option.isSome),
            Effect.tap((answered) => markUnreachable(!answered)),
          );
    return yield* openNetworkMember({
      environmentId,
      ...(listings[0] === undefined ? {} : { label: listings[0].label }),
      hosts: atomRegistry.get(openingHostsAtom),
      reachable,
      mint: (via, target) =>
        options.tailnetDevices.openDevice.run(atomRegistry, {
          environmentId: via,
          input: { environmentId: target },
        }),
      register: onboarding.openDevice,
    });
  });

  const open = createRuntimeCommand(runtime, {
    label: "network-members:open",
    scheduler,
    concurrency: { mode: "singleFlight", key: (environmentId: EnvironmentId) => environmentId },
    execute: openMember,
  });

  /**
   * The row switch, "Show in this app": a saved machine connects or disconnects here; a member
   * not saved yet is remembered as off, or switched on to be opened by `dueOpensAtom`.
   */
  const setShown = createRuntimeCommand(runtime, {
    label: "network-members:set-shown",
    scheduler,
    concurrency: {
      mode: "latest",
      key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
    },
    execute: Effect.fn("NetworkMembers.setShown")(function* (input: {
      readonly environmentId: EnvironmentId;
      readonly shown: boolean;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const members = yield* NetworkMembers;
      if ((yield* SubscriptionRef.get(registry.entries)).has(input.environmentId)) {
        return yield* registry.setEnabled(input.environmentId, input.shown);
      }
      yield* members.update((current) =>
        Effect.succeed(
          current.some(
            (record) =>
              record.environmentId === input.environmentId && (record.off === true) === input.shown,
          )
            ? current.map((record) => {
                if (record.environmentId !== input.environmentId) return record;
                const { off: _off, ...rest } = record;
                return input.shown ? rest : { ...rest, off: true as const };
              })
            : current,
        ),
      );
    }),
  });

  const renew = createRuntimeCommand(runtime, {
    label: "network-members:renew",
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: (renewal: NetworkMemberRenewal) => renewal.environmentId,
    },
    execute: (renewal: NetworkMemberRenewal, atomRegistry: AtomRegistry.AtomRegistry) => {
      const setAttempt = (attempt: NetworkMemberAttempt | null) =>
        Effect.sync(() => {
          const next = new Map(atomRegistry.get(attemptsAtom).byId);
          if (attempt === null) next.delete(renewal.environmentId);
          else next.set(renewal.environmentId, attempt);
          atomRegistry.set(attemptsAtom, { byId: next });
        });
      return renewals.renew(
        renewal,
        openMember(renewal.environmentId, atomRegistry).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
              ? setAttempt(null)
              : setAttempt({ phase: "failed", reason: failureReason(exit.cause) }),
          ),
        ),
        setAttempt({ phase: "connecting" }),
        Effect.sync(() =>
          atomRegistry.get(dueOpensAtom).find((due) => due.environmentId === renewal.environmentId),
        ),
      );
    },
  });

  return {
    recordsAtom,
    unopenedAtom,
    unreachableAtom,
    attemptsAtom,
    pausedAtom,
    statusAtom,
    reportsAtom,
    followedHostsAtom,
    openingHostsAtom,
    dueOpensAtom,
    follow,
    open,
    setShown,
    renew,
  };
}
