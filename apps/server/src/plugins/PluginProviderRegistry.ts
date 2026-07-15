/**
 * Provider drivers contributed by plugins.
 *
 * Every AI provider this build talks to is a `ProviderDriver` in
 * `BUILT_IN_DRIVERS` — a static array, compiled in. Adding one means editing this
 * repo. This is the seam that lets a plugin ship one instead.
 *
 * WHY THIS IS A SEPARATE REGISTRY, AND NOT AN APPEND TO BUILT_IN_DRIVERS:
 *
 * The provider instance registry takes its driver list ONCE, at layer-build time
 * (`makeProviderInstanceRegistry({ drivers })`). Plugins activate later — PluginHost
 * starts after the runtime layer is already built — so a plugin's driver cannot be in
 * that array. Making the instance registry consume drivers dynamically is the real
 * cost of this feature, and it is deliberately NOT done here: this module is the
 * registration + validation half, which is testable and safe on its own.
 *
 * Until that lands, a plugin's driver is registered and validated but not yet
 * instantiable. That is stated plainly rather than papered over — a half-wired
 * feature that claims to work is worse than one that says what it does.
 *
 * @module plugins/PluginProviderRegistry
 */
import type { PluginProviderDescriptor } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface RegisteredPluginProvider {
  readonly pluginId: string;
  readonly descriptor: PluginProviderDescriptor;
}

/**
 * Reject a driver the host cannot honour, BEFORE it is registered.
 *
 * Returns the reason, or null when acceptable.
 */
export const findProviderDescriptorViolation = (input: {
  readonly descriptor: PluginProviderDescriptor;
  /** Kinds already taken — built-ins and other plugins. */
  readonly takenKinds: ReadonlySet<string>;
}): string | null => {
  const kind = input.descriptor.driverKind;
  if (kind.trim() === "") {
    return "provider driverKind must not be empty";
  }
  if (input.takenKinds.has(kind)) {
    // A driver kind is the routing key: two drivers claiming one kind means every
    // instance of it resolves to whichever registered last. Silently shadowing a
    // BUILT-IN provider would be worse still — a plugin could quietly take over
    // "codex" and see every request meant for it.
    return `provider driverKind "${kind}" is already registered; a driver kind is the routing key and cannot be shared`;
  }
  if (input.descriptor.displayName.trim() === "") {
    return `provider "${kind}" must declare a displayName; it is what the user picks in settings`;
  }
  return null;
};

export class PluginProviderRegistry extends Context.Service<
  PluginProviderRegistry,
  {
    /** Register a plugin's drivers. Fails if a kind collides — see the violation reasons. */
    readonly put: (
      pluginId: string,
      descriptors: ReadonlyArray<PluginProviderDescriptor>,
    ) => Effect.Effect<void, string>;
    readonly remove: (pluginId: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<RegisteredPluginProvider>>;
    /** Kinds currently claimed, so callers can check a collision before registering. */
    readonly takenKinds: Effect.Effect<ReadonlySet<string>>;
  }
>()("t3/plugins/PluginProviderRegistry") {}

export const make = Effect.fn("PluginProviderRegistry.make")(function* (
  /** Built-in kinds, which a plugin must never shadow. */
  builtInKinds: ReadonlySet<string>,
) {
  const entries = new Map<string, ReadonlyArray<PluginProviderDescriptor>>();

  const claimed = () => {
    const kinds = new Set<string>(builtInKinds);
    for (const descriptors of entries.values()) {
      for (const descriptor of descriptors) kinds.add(descriptor.driverKind);
    }
    return kinds;
  };

  return PluginProviderRegistry.of({
    put: (pluginId, descriptors) =>
      Effect.gen(function* () {
        // Validate against kinds claimed by everyone ELSE, so re-registering the same
        // plugin (an upgrade re-running register()) does not collide with itself.
        const others = new Set<string>(builtInKinds);
        for (const [otherId, otherDescriptors] of entries) {
          if (otherId === pluginId) continue;
          for (const descriptor of otherDescriptors) others.add(descriptor.driverKind);
        }
        const seen = new Set<string>();
        for (const descriptor of descriptors) {
          const violation = findProviderDescriptorViolation({
            descriptor,
            takenKinds: new Set([...others, ...seen]),
          });
          if (violation !== null) return yield* Effect.fail(violation);
          seen.add(descriptor.driverKind);
        }
        entries.set(pluginId, descriptors);
      }),
    remove: (pluginId) =>
      Effect.sync(() => {
        entries.delete(pluginId);
      }),
    list: Effect.sync(() =>
      [...entries].flatMap(([pluginId, descriptors]) =>
        descriptors.map((descriptor) => ({ pluginId, descriptor })),
      ),
    ),
    takenKinds: Effect.sync(claimed),
  });
});

export const layerWith = (builtInKinds: ReadonlySet<string>) =>
  Layer.effect(PluginProviderRegistry, make(builtInKinds));
