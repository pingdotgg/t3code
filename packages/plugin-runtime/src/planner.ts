import * as Schema from "effect/Schema";

import type { PluginDefinition } from "./contract.ts";

export interface PlannedComposition {
  readonly blocked: Readonly<Record<string, string>>;
  readonly definitions: ReadonlyArray<PluginDefinition>;
}

export class DuplicatePluginIdError extends Schema.TaggedErrorClass<DuplicatePluginIdError>()(
  "DuplicatePluginIdError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Duplicate plugin id: ${this.pluginId}`;
  }
}

export class DuplicateCapabilityError extends Schema.TaggedErrorClass<DuplicateCapabilityError>()(
  "DuplicateCapabilityError",
  {
    capability: Schema.String,
    pluginId: Schema.String,
    previousPluginId: Schema.String,
  },
) {
  override get message(): string {
    return `Duplicate capability ${this.capability} provided by ${this.previousPluginId} and ${this.pluginId}`;
  }
}

export class DependencyCycleError extends Schema.TaggedErrorClass<DependencyCycleError>()(
  "DependencyCycleError",
  { cycle: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Dependency cycle: ${this.cycle.join(" -> ")}`;
  }
}

export const PluginPlanningError = Schema.Union([
  DuplicatePluginIdError,
  DuplicateCapabilityError,
  DependencyCycleError,
]);
export type PluginPlanningError = typeof PluginPlanningError.Type;

export const isPluginPlanningError = Schema.is(PluginPlanningError);

const createNullPrototypeRecord = <Value>(): Record<string, Value> =>
  Object.create(null) as Record<string, Value>;

export const planComposition = (
  definitions: ReadonlyArray<PluginDefinition>,
): PlannedComposition => {
  const definitionsById = new Map<string, PluginDefinition>();
  const providersByCapability = new Map<string, PluginDefinition>();

  for (const definition of definitions) {
    if (definitionsById.has(definition.id)) {
      throw new DuplicatePluginIdError({ pluginId: definition.id });
    }
    definitionsById.set(definition.id, definition);

    for (const capability of Object.keys(definition.provides ?? {})) {
      const previous = providersByCapability.get(capability);
      if (previous !== undefined) {
        throw new DuplicateCapabilityError({
          capability,
          pluginId: definition.id,
          previousPluginId: previous.id,
        });
      }
      providersByCapability.set(capability, definition);
    }
  }

  interface VisitFrame {
    readonly definition: PluginDefinition;
    requirementIndex: number;
    reason: string | undefined;
  }

  const states = new Map<string, "visiting" | "visited">();
  const path: Array<string> = [];
  const pathIndexes = new Map<string, number>();
  const ordered: Array<PluginDefinition> = [];
  const blocked = createNullPrototypeRecord<string>();

  for (const root of definitions) {
    if (states.has(root.id)) continue;

    const stack: Array<VisitFrame> = [{ definition: root, requirementIndex: 0, reason: undefined }];
    states.set(root.id, "visiting");
    pathIndexes.set(root.id, path.length);
    path.push(root.id);

    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const requirements = frame.definition.requires ?? [];
      const capability = requirements[frame.requirementIndex];

      if (capability !== undefined) {
        const provider = providersByCapability.get(capability);
        if (provider === undefined) {
          frame.reason ??= `Missing dependency: ${capability}`;
          frame.requirementIndex += 1;
          continue;
        }

        const state = states.get(provider.id);
        if (state === "visiting") {
          const cycleStart = pathIndexes.get(provider.id);
          if (cycleStart === undefined) {
            throw new DependencyCycleError({ cycle: [provider.id, provider.id] });
          }
          throw new DependencyCycleError({ cycle: [...path.slice(cycleStart), provider.id] });
        }
        if (state === undefined) {
          stack.push({ definition: provider, requirementIndex: 0, reason: undefined });
          states.set(provider.id, "visiting");
          pathIndexes.set(provider.id, path.length);
          path.push(provider.id);
          continue;
        }

        if (Object.hasOwn(blocked, provider.id)) {
          frame.reason ??= `Dependency ${capability} is blocked: ${blocked[provider.id]}`;
        }
        frame.requirementIndex += 1;
        continue;
      }

      stack.pop();
      path.pop();
      pathIndexes.delete(frame.definition.id);
      states.set(frame.definition.id, "visited");
      if (frame.reason === undefined) {
        ordered.push(frame.definition);
      } else {
        blocked[frame.definition.id] = frame.reason;
      }
    }
  }

  return { blocked, definitions: ordered };
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

const sameDefinition = (left: PluginDefinition, right: PluginDefinition): boolean => {
  if (
    left.id !== right.id ||
    left.version !== right.version ||
    !Object.is(left.activate, right.activate)
  ) {
    return false;
  }
  if (!sameStrings(left.requires ?? [], right.requires ?? [])) return false;

  const leftProvides = left.provides ?? {};
  const rightProvides = right.provides ?? {};
  const leftCapabilities = Object.keys(leftProvides);
  const rightCapabilities = Object.keys(rightProvides);
  return (
    leftCapabilities.length === rightCapabilities.length &&
    leftCapabilities.every(
      (capability) =>
        Object.hasOwn(rightProvides, capability) &&
        Object.is(leftProvides[capability], rightProvides[capability]),
    )
  );
};

const dependentsByPlugin = (definitions: ReadonlyArray<PluginDefinition>) => {
  const providers = new Map<string, string>();
  const dependents = new Map<string, Set<string>>();
  for (const definition of definitions) {
    for (const capability of Object.keys(definition.provides ?? {})) {
      providers.set(capability, definition.id);
    }
  }
  for (const definition of definitions) {
    for (const capability of definition.requires ?? []) {
      const providerId = providers.get(capability);
      if (providerId === undefined) continue;
      const values = dependents.get(providerId) ?? new Set<string>();
      values.add(definition.id);
      dependents.set(providerId, values);
    }
  }
  return dependents;
};

export const affectedPluginIds = (
  current: ReadonlyArray<PluginDefinition>,
  desired: ReadonlyArray<PluginDefinition>,
): ReadonlySet<string> => {
  const currentById = new Map(current.map((definition) => [definition.id, definition]));
  const desiredById = new Map(desired.map((definition) => [definition.id, definition]));
  const affected = new Set<string>();

  for (const definition of current) {
    const next = desiredById.get(definition.id);
    if (next === undefined || !sameDefinition(definition, next)) affected.add(definition.id);
  }
  for (const definition of desired) {
    const previous = currentById.get(definition.id);
    if (previous === undefined || !sameDefinition(previous, definition))
      affected.add(definition.id);
  }

  const currentDependents = dependentsByPlugin(current);
  const desiredDependents = dependentsByPlugin(desired);
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    const pluginId = queue[index];
    if (pluginId === undefined) continue;
    for (const dependent of [
      ...(currentDependents.get(pluginId) ?? []),
      ...(desiredDependents.get(pluginId) ?? []),
    ]) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return affected;
};
