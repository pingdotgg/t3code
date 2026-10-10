import {
  type ContributionStatusEntry,
  type ContributionStatusSnapshot,
  contributionStatusSourceKey,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const EMPTY_SNAPSHOT: ContributionStatusSnapshot = { entries: [] };
const NO_ENTRIES: ReadonlyArray<ContributionStatusEntry> = [];

/** Older servers lack the stream; clients show nothing for them and never subscribe. */
function supportsContributionStatus(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.contributionStatus === true;
}

/** A thread's entries, one per source, in the server's order. */
function threadContributionStatusEntries(
  snapshot: ContributionStatusSnapshot,
  threadId: ThreadId,
): ReadonlyArray<ContributionStatusEntry> {
  const entries = snapshot.entries.filter((entry) => entry.threadId === threadId);
  return entries.length === 0 ? NO_ENTRIES : entries;
}

/** A source's displayed name, which is not part of its identity. */
const sourceName = (entry: ContributionStatusEntry) =>
  entry.source.kind === "plugin" ? entry.source.name : undefined;

/** Equal when every entry has the same source identity and name and the same items. */
function sameEntries(
  left: ReadonlyArray<ContributionStatusEntry>,
  right: ReadonlyArray<ContributionStatusEntry>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        contributionStatusSourceKey(entry.source) === contributionStatusSourceKey(other.source) &&
        sourceName(entry) === sourceName(other) &&
        entry.items.length === other.items.length &&
        entry.items.every((item, itemIndex) => {
          const otherItem = other.items[itemIndex];
          return (
            otherItem !== undefined &&
            item.key === otherItem.key &&
            item.text === otherItem.text &&
            item.tone === otherItem.tone &&
            item.tooltip === otherItem.tooltip
          );
        })
      );
    })
  );
}

/**
 * Live thread statuses per environment for the web and mobile renderers.
 * Nothing subscribes until a renderer reads an atom, and only against servers
 * that advertise the capability. Each server frame is a full replacement, so a
 * reconnect's first frame drops statuses that ended while disconnected.
 *
 * `threadStatus` keeps each entry's source: renderers key an entry by
 * `contributionStatusSourceKey(entry.source)` and an item by that plus its
 * key, so a provider session taking over a thread re-keys its rows even when
 * the text is unchanged.
 */
export function createContributionStatusEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  },
) {
  const subscription = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:contribution-status",
    tag: WS_METHODS.subscribeContributionStatus,
  });
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ContributionStatusSnapshot => {
      if (!supportsContributionStatus(get(options.configValueAtom(environmentId)))) {
        return EMPTY_SNAPSHOT;
      }
      return Option.getOrElse(
        AsyncResult.value(get(subscription({ environmentId, input: {} }))),
        () => EMPTY_SNAPSHOT,
      );
    }).pipe(Atom.withLabel(`environment-data:contribution-status:snapshot:${environmentId}`)),
  );
  const threadStatusFamily = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    // A change on another thread keeps this thread's array, so its row does not re-render.
    let previous = NO_ENTRIES;
    return Atom.make((get) => {
      const next = threadContributionStatusEntries(get(snapshotAtom(environmentId)), threadId);
      if (!sameEntries(previous, next)) previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-data:contribution-status:thread:${key}`));
  });
  return {
    snapshot: snapshotAtom,
    threadStatus: (environmentId: EnvironmentId, threadId: ThreadId) =>
      threadStatusFamily(JSON.stringify([environmentId, threadId])),
  };
}
