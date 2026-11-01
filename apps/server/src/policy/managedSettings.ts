import {
  DEFAULT_SERVER_SETTINGS,
  isRuntimeModeAbove,
  type ManagedPolicySetting,
  ProjectSettingsOverrides,
  type RuntimeMode,
  ServerSettings,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { mapSettingsSecrets } from "../settingsSecrets.ts";

const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeSettingsExit = Schema.decodeUnknownExit(ServerSettings);

/** Project overrides mirror these top-level keys, so a lock on one applies inside each project. */
const PROJECT_OVERRIDE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(ProjectSettingsOverrides.fields),
);
/** Per-project stores; admins lock the top-level key and the lock reaches every project. */
const UNMANAGEABLE_KEYS: ReadonlySet<string> = new Set([
  "projectSettingsOverrides",
  "projectAgentBrowserAccessOverrides",
  "projectAutoPullOverrides",
  "projectScriptOverrides",
]);

/** Legacy settings the server derives from another on every write; manage that one instead. */
const DERIVED_FROM: ReadonlyMap<string, string> = new Map([
  ["compactIdleThreads", "idleCompaction"],
]);

/**
 * Settings another one overrides when it is set: `worktreeCleanup`, also per project, wins over
 * the worktree rules in `storageCleanup`. A lock on the first alone would look enforced without
 * being, so the second must be locked too.
 */
const OVERRIDDEN_BY: ReadonlyArray<readonly [overridden: string, by: string]> = [
  ["storageCleanup.worktree", "worktreeCleanup"],
];

type Segments = ReadonlyArray<string>;

/**
 * The server derives the legacy switch from `idleCompaction` on every write, and shipped clients
 * still read it, so values the policy sets carry the matching switch.
 */
const syncIdleCompaction = (settings: ServerSettings): ServerSettings =>
  settings.idleCompaction === undefined
    ? settings
    : withIdleCompaction(settings, settings.idleCompaction);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getPath = (tree: unknown, segments: Segments): unknown => {
  let current = tree;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
};

const setPath = (tree: unknown, segments: Segments, value: unknown): unknown => {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const record = isRecord(tree) ? tree : {};
  if (value === undefined && rest.length === 0) {
    const { [head]: _removed, ...remaining } = record;
    return remaining;
  }
  return { ...record, [head]: setPath(record[head], rest, value) };
};

/** Fills keys `target` lacks from `defaults`, recursing into objects both sides hold. */
const fillMissing = (target: unknown, defaults: unknown): unknown => {
  if (!isRecord(target) || !isRecord(defaults)) return target;
  const next: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(defaults)) {
    next[key] = key in target ? fillMissing(target[key], value) : value;
  }
  return next;
};

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => jsonEqual(left[key], right[key]))
  );
};

/**
 * Whether `value` agrees with a lock on every key it holds. Patches and project overrides carry
 * only some of a locked object's keys, such as `{ enabled }` for a provider instance.
 */
const matchesLock = (value: unknown, lock: unknown): boolean =>
  isRecord(value) && isRecord(lock)
    ? Object.entries(value).every(
        ([key, child]) => child === undefined || matchesLock(child, lock[key]),
      )
    : jsonEqual(value, lock);

/** Whether `value` holds a key `existing` does not, at any depth. */
const addsKeys = (existing: unknown, value: unknown): boolean =>
  isRecord(existing) &&
  isRecord(value) &&
  Object.entries(value).some(([key, child]) =>
    key in existing ? addsKeys(existing[key], child) : true,
  );

/**
 * How a policy's `settings` shape the server's settings. Policy values are never written to
 * the user's settings file: defaults fill keys the file leaves out, and locks are laid over the
 * result on every read, so removing the policy brings the user's own settings back.
 */
export interface ManagedSettings {
  /** Fill policy defaults into a parsed settings file before it is decoded. */
  readonly withDefaults: (persisted: unknown) => unknown;
  /** Built-in defaults with the policy's defaults applied; the settings file omits values equal to these. */
  readonly defaults: ServerSettings;
  /**
   * Lay locked values over settings, including inside each project's overrides, and lower
   * default runtime modes above the policy's ceiling to it.
   */
  readonly applyLocks: (settings: ServerSettings) => ServerSettings;
  /**
   * Vet a write from `current` to `next`. It is refused when it tries to move a locked path off
   * its locked value, whether set in `patch` or changed by another route such as a legacy patch
   * key. An allowed write keeps the user's stored values at locked paths, so a client re-sending
   * the locked value does not overwrite what applies once the policy is gone.
   */
  readonly vetWrite: (
    current: ServerSettings,
    next: ServerSettings,
    patch: unknown,
  ) =>
    | { readonly _tag: "Allowed"; readonly settings: ServerSettings }
    | { readonly _tag: "Locked"; readonly path: string };
  readonly lockedPaths: ReadonlyArray<string>;
  /**
   * Put back into a stripped settings file the values `stored`, the file before this write, held
   * at or under paths the policy defaults: equal to the policy's default, they are still the
   * user's choice. A key `isAtomic` names comes back whole or not at all. Undefined without
   * policy defaults, so writers can skip reading the file.
   */
  readonly keepStored:
    | ((
        stripped: unknown,
        settings: ServerSettings,
        stored: unknown,
        isAtomic: (key: string) => boolean,
      ) => unknown)
    | undefined;
}

export const unmanagedSettings: ManagedSettings = {
  keepStored: undefined,
  withDefaults: (persisted) => persisted,
  defaults: DEFAULT_SERVER_SETTINGS,
  applyLocks: (settings) => settings,
  vetWrite: (_current, next) => ({ _tag: "Allowed", settings: next }),
  lockedPaths: [],
};

interface Entry {
  readonly path: string;
  readonly segments: Segments;
  /** As written in the policy, the encoded form. */
  readonly value: unknown;
}

interface Lock extends Entry {
  /** The decoded form, which is what patches carry. */
  readonly decodedValue: unknown;
}

/** Locked paths as stored in the top level and in each project's overrides of `encoded`. */
const lockTargets = (encoded: unknown, entry: Entry): ReadonlyArray<Segments> => {
  const [head] = entry.segments;
  if (head === undefined || !PROJECT_OVERRIDE_KEYS.has(head)) return [entry.segments];
  const projects = getPath(encoded, ["projectSettingsOverrides"]);
  const projectTargets = isRecord(projects)
    ? Object.entries(projects)
        .filter(([, overrides]) => isRecord(overrides) && overrides[head] !== undefined)
        .map(([projectId]) => ["projectSettingsOverrides", projectId, ...entry.segments])
    : [];
  return [entry.segments, ...projectTargets];
};

/**
 * A user's stored default runtime mode can sit above a ceiling deployed after it was chosen, and
 * the built-in default is the broadest mode. Every new thread would then be refused, so the
 * effective default is the ceiling instead. The stored value is untouched and returns with the
 * policy's removal; existing threads keep their modes and are refused turns instead.
 */
const clampDefaultRuntimeModes = (
  settings: ServerSettings,
  ceiling: RuntimeMode,
): ServerSettings => {
  const projectsAbove = Object.entries(settings.projectSettingsOverrides).filter(
    ([, overrides]) =>
      overrides.defaultRuntimeMode !== undefined &&
      isRuntimeModeAbove(overrides.defaultRuntimeMode, ceiling),
  );
  if (!isRuntimeModeAbove(settings.defaultRuntimeMode, ceiling) && projectsAbove.length === 0) {
    return settings;
  }
  return {
    ...settings,
    defaultRuntimeMode: isRuntimeModeAbove(settings.defaultRuntimeMode, ceiling)
      ? ceiling
      : settings.defaultRuntimeMode,
    projectSettingsOverrides: {
      ...settings.projectSettingsOverrides,
      ...Object.fromEntries(
        projectsAbove.map(([projectId, overrides]) => [
          projectId,
          { ...overrides, defaultRuntimeMode: ceiling },
        ]),
      ),
    },
  };
};

/** Build the overlay for a policy's settings, or describe the first entry this build cannot apply. */
export function makeManagedSettings(
  settings: Readonly<Record<string, ManagedPolicySetting>>,
  maxRuntimeMode?: RuntimeMode,
):
  | { readonly _tag: "Valid"; readonly settings: ManagedSettings }
  | { readonly _tag: "Invalid"; readonly reason: string } {
  const defaults: Entry[] = [];
  const locks: Entry[] = [];
  for (const [path, setting] of Object.entries(settings)) {
    const segments = path.split(".");
    const [head] = segments;
    if (head === undefined || segments.some((segment) => segment.length === 0)) {
      return { _tag: "Invalid", reason: `"${path}" is not a settings path` };
    }
    if (!(head in ServerSettings.fields) || UNMANAGEABLE_KEYS.has(head)) {
      return { _tag: "Invalid", reason: `"${path}" is not a setting this version can manage` };
    }
    const source = DERIVED_FROM.get(head);
    if (source !== undefined) {
      return {
        _tag: "Invalid",
        reason: `"${head}" follows "${source}"; manage "${source}" instead`,
      };
    }
    (setting.locked ? locks : defaults).push({ path, segments, value: setting.value });
  }

  for (const lock of locks) {
    const unheld = OVERRIDDEN_BY.find(
      ([overridden, by]) =>
        (lock.path.startsWith(overridden) || overridden.startsWith(`${lock.path}.`)) &&
        !locks.some((other) => other.path === by),
    );
    if (unheld !== undefined) {
      return {
        _tag: "Invalid",
        reason: `"${lock.path}" can be overridden by "${unheld[1]}"; lock "${unheld[1]}" too`,
      };
    }
    // An instance's fields override each other: a variable replaces launch arguments, a home
    // path rewrites a home variable, and a setup mode brings its own runtime.
    const [head, instanceId] = lock.segments;
    if (head === "providerInstances" && instanceId !== undefined && lock.segments.length > 2) {
      return {
        _tag: "Invalid",
        reason: `"${lock.path}" is one field of a provider instance whose fields override each other; lock "providerInstances.${instanceId}" as a whole, or pin fields with limits.providers.instances`,
      };
    }
  }

  // Apply every entry to the built-in defaults at once, and read each value back: a typo in a
  // nested key or a value of the wrong type does not survive the round trip.
  const builtIn = encodeSettings(DEFAULT_SERVER_SETTINGS);
  const all = [...defaults, ...locks];
  // A user's stored null would leave a nested lock building a partial object, so lock the whole
  // setting instead.
  const insideNullable = all.find((entry) =>
    entry.segments
      .slice(0, -1)
      .some((_, index) =>
        Exit.isSuccess(
          decodeSettingsExit(setPath(builtIn, entry.segments.slice(0, index + 1), null)),
        ),
      ),
  );
  if (insideNullable !== undefined) {
    return {
      _tag: "Invalid",
      reason: `"${insideNullable.path}" is inside a setting that can be empty; manage "${insideNullable.segments[0]}" as a whole`,
    };
  }
  const applied = all.reduce<unknown>(
    (tree, entry) => setPath(tree, entry.segments, entry.value),
    builtIn,
  );
  const decoded = decodeSettingsExit(applied);
  if (Exit.isFailure(decoded)) {
    return { _tag: "Invalid", reason: "a managed setting has a value of the wrong type" };
  }
  const roundTrip = encodeSettings(decoded.value);
  const lost = all.find((entry) => !jsonEqual(getPath(roundTrip, entry.segments), entry.value));
  if (lost !== undefined) {
    return {
      _tag: "Invalid",
      reason: `"${lost.path}" is not a setting this version can manage, or its value is invalid`,
    };
  }
  // The server moves a credential it finds in settings into the user's secret store, where a
  // policy's would outlive the policy. Built-in defaults hold none, so any found is the policy's.
  let holdsCredential = false;
  mapSettingsSecrets(decoded.value, (secret) => {
    if (secret.sensitive && !secret.redacted && secret.value.length > 0) holdsCredential = true;
    return secret;
  });
  if (holdsCredential) {
    return {
      _tag: "Invalid",
      reason:
        "a managed setting holds a credential, which every user can read in the policy; deploy credentials another way",
    };
  }
  // Defaults fill in what the file leaves out, so an entry a default adds to a record such as
  // `providerInstances` would come back each time the user removed it.
  const addsEntry = defaults.find((entry) => {
    const existing = getPath(builtIn, entry.segments);
    return existing === undefined ? entry.segments.length > 1 : addsKeys(existing, entry.value);
  });
  if (addsEntry !== undefined) {
    return {
      _tag: "Invalid",
      reason: `"${addsEntry.path}" adds entries users could not remove; lock it instead`,
    };
  }
  // A managed default above the ceiling would start every thread in a mode the policy refuses.
  if (
    all.some((entry) => entry.path === "defaultRuntimeMode") &&
    isRuntimeModeAbove(decoded.value.defaultRuntimeMode, maxRuntimeMode)
  ) {
    return {
      _tag: "Invalid",
      reason: `"defaultRuntimeMode" is above "limits.maxRuntimeMode"`,
    };
  }

  const defaultsTree = defaults.reduce<unknown>(
    (tree, entry) => setPath(tree, entry.segments, entry.value),
    {},
  );
  const lockEntries: ReadonlyArray<Lock> = locks.map((entry) => ({
    ...entry,
    decodedValue: getPath(decoded.value, entry.segments),
  }));
  const lockedPaths = locks.map((entry) => entry.path);
  const idleCompactionLocked = lockedPaths.includes("idleCompaction");
  const lockCache = new WeakMap<ServerSettings, ServerSettings>();

  const applyLocks = (current: ServerSettings): ServerSettings => {
    if (locks.length === 0 && maxRuntimeMode === undefined) return current;
    const cached = lockCache.get(current);
    if (cached !== undefined) return cached;
    const locked =
      locks.length === 0
        ? current
        : // Validated against the built-in defaults above, so a failure here is a bug, not bad input.
          decodeSettings(
            locks.reduce<unknown>(
              (tree, entry) =>
                lockTargets(tree, entry).reduce<unknown>(
                  (next, target) => setPath(next, target, entry.value),
                  tree,
                ),
              encodeSettings(current),
            ),
          );
    const derived = idleCompactionLocked ? syncIdleCompaction(locked) : locked;
    const result =
      maxRuntimeMode === undefined ? derived : clampDefaultRuntimeModes(derived, maxRuntimeMode);
    lockCache.set(current, result);
    return result;
  };

  const vetWrite: ManagedSettings["vetWrite"] = (current, next, patch) => {
    if (locks.length === 0) return { _tag: "Allowed", settings: next };
    const before = encodeSettings(current);
    const after = encodeSettings(next);
    const changed = lockEntries.find(
      (entry) =>
        // Re-sending a stored value the lock overrides changes nothing on disk, but it is still
        // an attempt to change what the user sees.
        lockTargets(patch, entry).some((target) => {
          const value = getPath(patch, target);
          return value !== undefined && !matchesLock(value, entry.decodedValue);
        }) ||
        lockTargets(after, entry).some((target) => {
          const value = getPath(after, target);
          // Removing a project's override of a locked key is harmless; the lock applies either way.
          return (
            value !== undefined &&
            !jsonEqual(value, getPath(before, target)) &&
            !matchesLock(value, entry.value)
          );
        }),
    );
    if (changed !== undefined) return { _tag: "Locked", path: changed.path };
    const kept = locks.reduce<unknown>(
      (tree, entry) =>
        lockTargets(tree, entry).reduce<unknown>((result, target) => {
          // A parent the write adds holds the locked value already; removing only the locked key
          // inside it would leave a partial object.
          const added = target
            .slice(0, -1)
            .some((_, index) => getPath(before, target.slice(0, index + 1)) === undefined);
          return added ? result : setPath(result, target, getPath(before, target));
        }, tree),
      after,
    );
    return { _tag: "Allowed", settings: decodeSettings(kept) };
  };

  // A file from before a setting replaced its legacy key holds the user's choice in that key, which
  // a default for the new setting would otherwise override.
  const withoutLegacyChoices = (persisted: unknown): unknown => {
    if (!isRecord(persisted) || !isRecord(defaultsTree)) return defaultsTree;
    const kept = { ...defaultsTree };
    for (const [legacy, source] of DERIVED_FROM) {
      if (persisted[legacy] !== undefined && persisted[source] === undefined) delete kept[source];
    }
    return kept;
  };

  // The paths keepStored puts back: each default, cut at an atomic setting, and the legacy key a
  // defaulted setting replaced, which an older file holds the user's choice in.
  const restoredPaths = (isAtomic: (key: string) => boolean): ReadonlyArray<Segments> => [
    ...defaults.map((entry) => {
      const atomicAt = entry.segments.findIndex(isAtomic);
      return atomicAt === -1 ? entry.segments : entry.segments.slice(0, atomicAt + 1);
    }),
    ...[...DERIVED_FROM]
      .filter(([, source]) => defaults.some((entry) => entry.path === source))
      .map(([legacy]) => [legacy]),
  ];

  const keepStored: ManagedSettings["keepStored"] =
    defaults.length === 0
      ? undefined
      : (stripped, settings, stored, isAtomic) => {
          const encoded = encodeSettings(settings);
          const restore = (tree: unknown, segments: Segments): unknown => {
            const previous = getPath(stored, segments);
            if (previous === undefined) return tree;
            if (isRecord(previous) && !isAtomic(segments.at(-1) ?? "")) {
              return Object.keys(previous).reduce<unknown>(
                (next, key) => restore(next, [...segments, key]),
                tree,
              );
            }
            return getPath(tree, segments) === undefined &&
              jsonEqual(previous, getPath(encoded, segments))
              ? setPath(tree, segments, getPath(settings, segments))
              : tree;
          };
          // A default inside an atomic setting restores that whole setting, never part of it.
          return restoredPaths(isAtomic).reduce<unknown>(restore, stripped);
        };

  return {
    _tag: "Valid",
    settings: {
      keepStored,
      withDefaults: (persisted) => fillMissing(persisted, withoutLegacyChoices(persisted)),
      defaults: syncIdleCompaction(
        decodeSettings(
          defaults.reduce<unknown>(
            (tree, entry) => setPath(tree, entry.segments, entry.value),
            builtIn,
          ),
        ),
      ),
      applyLocks,
      vetWrite,
      lockedPaths,
    },
  };
}
