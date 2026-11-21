export type PluginContribution<Slots extends object> = {
  [Slot in keyof Slots & string]: {
    readonly slot: Slot;
    readonly id: string;
    readonly order?: number;
    readonly load: () => Slots[Slot];
  };
}[keyof Slots & string];

export interface PluginContributionMetadata {
  readonly pluginId: string;
  readonly slot: string;
  readonly id: string;
  readonly order: number;
}

export interface PluginRegistrySnapshot {
  readonly revision: number;
  readonly contributions: readonly PluginContributionMetadata[];
}

export interface PluginContributionEntry<Value> extends PluginContributionMetadata {
  readonly load: () => Value;
}

export interface PluginRegistry<Slots extends object> {
  /** Replaces one plugin's complete contribution set in a single notification. */
  readonly register: (
    pluginId: string,
    contributions: readonly PluginContribution<Slots>[],
  ) => () => void;
  readonly unregister: (pluginId: string) => void;
  readonly resolve: <Slot extends keyof Slots & string>(
    slot: Slot,
    id: string,
  ) => Slots[Slot] | undefined;
  readonly entries: <Slot extends keyof Slots & string>(
    slot: Slot,
  ) => readonly PluginContributionEntry<Slots[Slot]>[];
  readonly snapshot: () => PluginRegistrySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribeSlot: <Slot extends keyof Slots & string>(
    slot: Slot,
    listener: () => void,
  ) => () => void;
  /** Refreshes a slot's observers when host-owned values change outside contributions. */
  readonly notifySlot?: <Slot extends keyof Slots & string>(slot: Slot) => void;
}

/** A client-independent registry: no component imports, eager loading, or process globals. */
export function createPluginRegistry<Slots extends object>(): PluginRegistry<Slots> {
  type Registration = { readonly entries: readonly PluginContributionEntry<unknown>[] };
  const registrations = new Map<string, Registration>();
  const listeners = new Set<() => void>();
  const slotListeners = new Map<string, Set<() => void>>();
  const slotIndex = new Map<string, Map<string, readonly PluginContributionEntry<unknown>[]>>();
  let revision = 0;
  let currentSnapshot: PluginRegistrySnapshot | undefined = Object.freeze({
    revision,
    contributions: Object.freeze([]),
  });
  const slotEntries = new Map<string, readonly PluginContributionEntry<unknown>[]>();

  const updateSlots = (
    pluginId: string,
    previous: readonly PluginContributionEntry<unknown>[],
    next: readonly PluginContributionEntry<unknown>[],
  ) => {
    const affected = new Map<string, PluginContributionEntry<unknown>[]>();
    for (const entry of previous) affected.set(entry.slot, []);
    for (const entry of next) {
      const additions = affected.get(entry.slot) ?? [];
      additions.push(entry);
      affected.set(entry.slot, additions);
    }
    for (const [slot, additions] of affected) {
      const indexed =
        slotIndex.get(slot) ?? new Map<string, readonly PluginContributionEntry<unknown>[]>();
      indexed.delete(pluginId);
      if (additions.length) indexed.set(pluginId, additions);
      if (indexed.size) slotIndex.set(slot, indexed);
      else slotIndex.delete(slot);
      slotEntries.delete(slot);
    }
    return affected.keys();
  };

  const publish = (affected: Iterable<string>) => {
    revision += 1;
    currentSnapshot = undefined;
    // Reentrant subscription changes apply to the next notification.
    const notificationListeners = new Set(listeners);
    for (const slot of affected) {
      for (const listener of slotListeners.get(slot) ?? []) notificationListeners.add(listener);
    }
    for (const listener of notificationListeners) {
      try {
        listener();
      } catch {
        // Observer failures cannot invalidate a committed generation or skip other observers.
      }
    }
  };

  const entries = <Slot extends keyof Slots & string>(
    slot: Slot,
  ): readonly PluginContributionEntry<Slots[Slot]>[] => {
    let cached = slotEntries.get(slot);
    if (cached === undefined) {
      cached = Object.freeze(
        [...(slotIndex.get(slot)?.values() ?? [])]
          .flatMap((indexed) => indexed)
          .sort((left, right) => left.order - right.order),
      );
      slotEntries.set(slot, cached);
    }
    return cached as readonly PluginContributionEntry<Slots[Slot]>[];
  };

  return {
    register: (pluginId, contributions) => {
      if (pluginId.length === 0) throw new Error("A plugin id is required.");
      const keys = new Set<string>();
      const prepared = contributions.map((contribution) => {
        const key = JSON.stringify([contribution.slot, contribution.id]);
        if (keys.has(key)) {
          throw new Error(`Duplicate plugin contribution: ${contribution.slot}/${contribution.id}`);
        }
        keys.add(key);
        if (contribution.id.length === 0 || !Number.isFinite(contribution.order ?? 0)) {
          throw new Error("Contributions require a nonempty id and finite order.");
        }
        let loaded = false;
        let value: unknown;
        return Object.freeze({
          pluginId,
          slot: contribution.slot,
          id: contribution.id,
          order: contribution.order ?? 0,
          load: () => {
            if (!loaded) {
              value = contribution.load();
              loaded = true;
            }
            return value;
          },
        });
      });
      const registration = { entries: Object.freeze(prepared) };
      const previous = registrations.get(pluginId);
      // Reinsertion makes the newest replacement win ties without disturbing other plugins.
      registrations.delete(pluginId);
      registrations.set(pluginId, registration);
      publish(updateSlots(pluginId, previous?.entries ?? [], registration.entries));
      return () => {
        if (registrations.get(pluginId) !== registration) return;
        registrations.delete(pluginId);
        publish(updateSlots(pluginId, registration.entries, []));
      };
    },
    unregister: (pluginId) => {
      const registration = registrations.get(pluginId);
      if (registration === undefined) return;
      registrations.delete(pluginId);
      publish(updateSlots(pluginId, registration.entries, []));
    },
    entries,
    resolve: (slot, id) => {
      const candidates = entries(slot);
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const entry = candidates[index];
        if (entry?.id === id) return entry.load();
      }
      return undefined;
    },
    snapshot: () => {
      currentSnapshot ??= Object.freeze({
        revision,
        contributions: Object.freeze(
          [...registrations.values()].flatMap((registration) =>
            registration.entries.map(({ pluginId, slot, id, order }) =>
              Object.freeze({ pluginId, slot, id, order }),
            ),
          ),
        ),
      });
      return currentSnapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeSlot: (slot, listener) => {
      const subscribed = slotListeners.get(slot) ?? new Set<() => void>();
      subscribed.add(listener);
      slotListeners.set(slot, subscribed);
      return () => {
        subscribed.delete(listener);
        if (subscribed.size === 0 && slotListeners.get(slot) === subscribed)
          slotListeners.delete(slot);
      };
    },
    notifySlot: (slot) => {
      for (const listener of new Set(slotListeners.get(slot))) {
        try {
          listener();
        } catch {
          // A failed observer cannot prevent its siblings from refreshing.
        }
      }
    },
  };
}
