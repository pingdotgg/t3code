/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingsConfigError,
  KeybindingShortcut,
  KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
  type ServerConfigIssue,
} from "@t3tools/contracts";
import * as Array from "effect/Array";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "./config.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { causeErrorTag } from "@t3tools/shared/observability";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

export {
  DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
};

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue(Option.some(rule), {
                message: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(resolved), {
                message: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

export const ResolvedKeybindingsFromConfig = Schema.Array(ResolvedKeybindingFromConfig).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  if (!parsed) return null;
  const encoded = encodeShortcut(parsed);
  if (!encoded) return null;
  return `${encoded}\u0000${rule.when ?? ""}`;
}

function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

function keybindingRuleFromUpsertInput(input: ServerUpsertKeybindingInput): KeybindingRule {
  return input.when === undefined
    ? { key: input.key, command: input.command }
    : { key: input.key, command: input.command, when: input.when };
}

function replaceTargetFromUpsertInput(input: ServerUpsertKeybindingInput): KeybindingRule | null {
  if (!input.replace) return null;
  return input.replace.when === undefined
    ? { key: input.replace.key, command: input.replace.command }
    : { key: input.replace.key, command: input.replace.command, when: input.replace.when };
}

function keybindingRuleFromRemoveInput(input: ServerRemoveKeybindingInput): KeybindingRule {
  return input.when === undefined
    ? { key: input.key, command: input.command }
    : { key: input.key, command: input.command, when: input.when };
}

function encodeShortcut(shortcut: KeybindingShortcut): string | null {
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  if (!shortcut.key) return null;
  if (shortcut.key !== "+" && shortcut.key.includes("+")) return null;
  const key = shortcut.key === " " ? "space" : shortcut.key;
  return [...modifiers, key].join("+");
}

function encodeWhenAst(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${encodeWhenAst(node.node)})`;
    case "and":
      return `(${encodeWhenAst(node.left)} && ${encodeWhenAst(node.right)})`;
    case "or":
      return `(${encodeWhenAst(node.left)} || ${encodeWhenAst(node.right)})`;
  }
}

const RawKeybindingsEntries = fromLenientJson(Schema.Array(Schema.Unknown));
const KeybindingsConfigPrettyJson = fromJsonStringPretty(KeybindingsConfig);
const decodeKeybindingRuleExit = Schema.decodeUnknownExit(KeybindingRule);
const decodeResolvedKeybindingFromConfigExit = Schema.decodeExit(ResolvedKeybindingFromConfig);
const decodeRawKeybindingsEntriesExit = Schema.decodeUnknownExit(RawKeybindingsEntries);
const encodeKeybindingsConfigPrettyJson = Schema.encodeEffect(KeybindingsConfigPrettyJson);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

const MALFORMED_KEYBINDINGS_CONFIG_MESSAGE =
  "Expected the keybindings configuration to be a JSON array.";
const INVALID_KEYBINDING_ENTRY_MESSAGE =
  "Expected a keybinding entry with key, command, and optional when fields.";
const INVALID_KEYBINDING_RULE_MESSAGE =
  "The keybinding entry contains an invalid shortcut or when expression.";

function keybindingsCauseLogAttributes(cause: Cause.Cause<unknown>) {
  return {
    errorTag: causeErrorTag(cause),
    causeReasonCount: cause.reasons.length,
    causeFailureCount: cause.reasons.filter(Cause.isFailReason).length,
    causeDefectCount: cause.reasons.filter(Cause.isDieReason).length,
    causeInterruptionCount: cause.reasons.filter(Cause.isInterruptReason).length,
  };
}

function keybindingsValidationInputLogAttributes(value: unknown) {
  if (typeof value === "string") {
    return { validationInputKind: "string", validationInputSize: value.length };
  }
  if (Array.isArray(value)) {
    return { validationInputKind: "array", validationInputSize: value.length };
  }
  if (typeof value === "object" && value !== null) {
    return {
      validationInputKind: "object",
      validationInputSize: Object.keys(value).length,
      validationHasKeyField: Object.hasOwn(value, "key"),
      validationHasCommandField: Object.hasOwn(value, "command"),
      validationHasWhenField: Object.hasOwn(value, "when"),
    };
  }
  return { validationInputKind: value === null ? "null" : typeof value };
}

function keybindingsValidationLogAttributes(input: {
  readonly stage: "document" | "entry-schema" | "resolved-rule";
  readonly value: unknown;
  readonly cause: Cause.Cause<unknown>;
  readonly index?: number;
}) {
  return {
    validationStage: input.stage,
    ...(input.index === undefined ? {} : { entryIndex: input.index }),
    ...keybindingsValidationInputLogAttributes(input.value),
    ...keybindingsCauseLogAttributes(input.cause),
  };
}

function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends Context.Service<
  Keybindings,
  {
    /**
     * Start the keybindings runtime and attach file watching.
     *
     * Safe to call multiple times. The first successful call establishes the
     * runtime; later calls await the same startup.
     */
    readonly start: Effect.Effect<void, KeybindingsConfigError>;

    /**
     * Await keybindings runtime readiness.
     *
     * Readiness means the config directory exists, the watcher is attached, the
     * startup sync has completed, and the current snapshot has been loaded.
     */
    readonly ready: Effect.Effect<void, KeybindingsConfigError>;

    /**
     * Ensure the on-disk keybindings file exists and includes all default
     * commands so newly-added defaults are backfilled on startup.
     */
    readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

    /**
     * Load runtime keybindings state along with non-fatal configuration issues.
     */
    readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    /**
     * Read the latest keybindings snapshot from cache/disk.
     */
    readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    /**
     * Stream of keybindings config change events.
     */
    readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

    /**
     * Upsert a keybinding rule and persist the resulting configuration.
     *
     * Writes config atomically and enforces the max rule count by truncating
     * oldest entries when needed.
     */
    readonly upsertKeybindingRule: (
      input: ServerUpsertKeybindingInput,
    ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;

    /**
     * Remove a single persisted keybinding rule by exact key/command/when match.
     */
    readonly removeKeybindingRule: (
      input: ServerRemoveKeybindingInput,
    ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;
  }
>()("t3/keybindings") {}

const make = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          operation: "access",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          operation: "read",
          cause,
        }),
    ),
  );

  const loadWritableCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    readonly KeybindingRule[],
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return [];
    }

    const rawConfig = yield* readRawConfig.pipe(
      Effect.flatMap(Schema.decodeEffect(RawKeybindingsEntries)),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            operation: "decode",
            cause,
          }),
      ),
    );

    return yield* Effect.forEach(rawConfig, (entry, index) =>
      Effect.gen(function* () {
        const decodedRule = decodeKeybindingRuleExit(entry);
        if (decodedRule._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            ...keybindingsValidationLogAttributes({
              stage: "entry-schema",
              value: entry,
              cause: decodedRule.cause,
              index,
            }),
          });
          return null;
        }
        const resolved = decodeResolvedKeybindingFromConfigExit(decodedRule.value);
        if (resolved._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            ...keybindingsValidationLogAttributes({
              stage: "resolved-rule",
              value: entry,
              cause: resolved.cause,
              index,
            }),
          });
          return null;
        }
        return decodedRule.value;
      }),
    ).pipe(Effect.map(Array.filter(Predicate.isNotNull)));
  });

  const loadRuntimeCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    {
      readonly keybindings: readonly KeybindingRule[];
      readonly issues: readonly ServerConfigIssue[];
    },
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { keybindings: [], issues: [] };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = decodeRawKeybindingsEntriesExit(rawConfig);
    if (decodedEntries._tag === "Failure") {
      yield* Effect.logWarning("ignoring malformed keybindings config", {
        path: keybindingsConfigPath,
        ...keybindingsValidationLogAttributes({
          stage: "document",
          value: rawConfig,
          cause: decodedEntries.cause,
        }),
      });
      return {
        keybindings: [],
        issues: [
          {
            kind: "keybindings.malformed-config",
            message: MALFORMED_KEYBINDINGS_CONFIG_MESSAGE,
          },
        ],
      };
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of decodedEntries.value.entries()) {
      const decodedRule = decodeKeybindingRuleExit(entry);
      if (decodedRule._tag === "Failure") {
        issues.push({
          kind: "keybindings.invalid-entry",
          index,
          message: INVALID_KEYBINDING_ENTRY_MESSAGE,
        });
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          ...keybindingsValidationLogAttributes({
            stage: "entry-schema",
            value: entry,
            cause: decodedRule.cause,
            index,
          }),
        });
        continue;
      }

      const resolvedRule = decodeResolvedKeybindingFromConfigExit(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        issues.push({
          kind: "keybindings.invalid-entry",
          index,
          message: INVALID_KEYBINDING_RULE_MESSAGE,
        });
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          ...keybindingsValidationLogAttributes({
            stage: "resolved-rule",
            value: entry,
            cause: resolvedRule.cause,
            index,
          }),
        });
        continue;
      }
      keybindings.push(decodedRule.value);
    }

    return { keybindings, issues };
  });

  const writeConfigAtomically = (rules: readonly KeybindingRule[]) => {
    return encodeKeybindingsConfigPrettyJson(rules).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            operation: "encode",
            cause,
          }),
      ),
      Effect.map((encoded) => `${encoded}\n`),
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({
          filePath: keybindingsConfigPath,
          contents: encoded,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new KeybindingsConfigError({
                configPath: keybindingsConfigPath,
                operation: "write",
                cause,
              }),
          ),
        ),
      ),
    );
  };

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => ({
      keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(keybindings)),
      issues,
    })),
  );

  const resolvedConfigCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const revalidateAndEmit = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      const configState = yield* loadConfigStateFromCacheOrDisk;
      yield* emitChange(configState);
    }),
  );

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const configExists = yield* readConfigExists;
      if (!configExists) {
        yield* writeConfigAtomically(DEFAULT_KEYBINDINGS);
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadRuntimeCustomKeybindingsConfig();
      if (runtimeConfig.issues.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: keybindingsConfigPath,
            issueCount: runtimeConfig.issues.length,
            malformedConfigIssueCount: runtimeConfig.issues.filter(
              (issue) => issue.kind === "keybindings.malformed-config",
            ).length,
            invalidEntryIssueCount: runtimeConfig.issues.filter(
              (issue) => issue.kind === "keybindings.invalid-entry",
            ).length,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }
      const customConfig = runtimeConfig.keybindings;
      const existingCommands = new Set(customConfig.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        hasWhenContext: boolean;
      }> = [];
      for (const defaultRule of DEFAULT_KEYBINDINGS) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            hasWhenContext: defaultRule.when !== undefined,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }
      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          hasWhenContext: conflict.hasWhenContext,
          reason: "shortcut context already used by existing rule",
        });
      }
      if (missingDefaults.length === 0) {
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const matchingDefaults = Array.filterMap(DEFAULT_KEYBINDINGS, (defaultRule) =>
        customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule))
          ? Result.succeed(defaultRule.command)
          : Result.failVoid,
      );
      if (matchingDefaults.length > 0) {
        yield* Effect.logWarning("default keybinding rule already defined in user config", {
          path: keybindingsConfigPath,
          commands: matchingDefaults,
        });
      }

      const nextConfig = [...customConfig, ...missingDefaults];
      const cappedConfig =
        nextConfig.length > MAX_KEYBINDINGS_COUNT
          ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
          : nextConfig;
      if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
        yield* Effect.logWarning("truncating keybindings config to max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
        });
      }

      yield* writeConfigAtomically(cappedConfig);
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);
    const keybindingsConfigFile = path.basename(keybindingsConfigPath);
    const keybindingsConfigPathResolved = path.resolve(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("keybindings config revalidation failed", {
              path: keybindingsConfigPath,
              ...keybindingsCauseLogAttributes(cause),
            }),
      ),
    );

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedKeybindingsEvents = fs.watch(keybindingsConfigDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === keybindingsConfigFile ||
          event.path === keybindingsConfigPath ||
          path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedKeybindingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("keybindings config watcher failed", {
              path: keybindingsConfigPath,
              ...keybindingsCauseLogAttributes(cause),
            }),
      ),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const rule = keybindingRuleFromUpsertInput(input);
          const replaceTarget = replaceTargetFromUpsertInput(input);
          const nextConfig = [
            ...customConfig.filter((entry) => {
              if (replaceTarget) {
                return !isSameKeybindingRule(entry, replaceTarget);
              }
              return !isSameKeybindingRule(entry, rule);
            }),
            rule,
          ];
          const cappedConfig =
            nextConfig.length > MAX_KEYBINDINGS_COUNT
              ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
              : nextConfig;
          if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            yield* Effect.logWarning("truncating keybindings config to max entries", {
              path: keybindingsConfigPath,
              maxEntries: MAX_KEYBINDINGS_COUNT,
            });
          }
          yield* writeConfigAtomically(cappedConfig);
          const nextResolved = mergeWithDefaultKeybindings(
            compileResolvedKeybindingsConfig(cappedConfig),
          );
          yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, {
            keybindings: nextResolved,
            issues: [],
          });
          yield* emitChange({
            keybindings: nextResolved,
            issues: [],
          });
          return nextResolved;
        }),
      ),
    removeKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const target = keybindingRuleFromRemoveInput(input);
          const nextConfig = customConfig.filter((entry) => !isSameKeybindingRule(entry, target));
          yield* writeConfigAtomically(nextConfig);
          const nextResolved = mergeWithDefaultKeybindings(
            compileResolvedKeybindingsConfig(nextConfig),
          );
          yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, {
            keybindings: nextResolved,
            issues: [],
          });
          yield* emitChange({
            keybindings: nextResolved,
            issues: [],
          });
          return nextResolved;
        }),
      ),
  } satisfies Keybindings["Service"];
});

export const layer = Layer.effect(Keybindings, make);
