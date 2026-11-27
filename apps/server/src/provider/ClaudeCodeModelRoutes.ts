import {
  type ModelInfo as ClaudeModelInfo,
  resolveSettings as resolveClaudeSettings,
  type SettingSource,
  type Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { claudeLocalSettingsDirectory } from "./Drivers/ClaudeHome.ts";
import { type ClaudeModelCatalog, withClaudeCodeModelRoutes } from "./ClaudeModelCatalog.ts";

// Env names that pick the backend, its region, or the model a family alias resolves to.
const MODEL_SETTINGS_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",
  "AWS_",
  "CLOUD_ML_",
  "VERTEX_",
];

/** Equal keys mean Claude Code resolves model ids the same way under both settings. */
function claudeModelSettingsKey(settings: ClaudeSdkSettings): string {
  const sortedEntries = (record: Readonly<Record<string, string | undefined>> | undefined) =>
    Object.entries(record ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    settings.availableModels ?? null,
    sortedEntries(settings.modelOverrides),
    sortedEntries(settings.env).filter(([name]) =>
      MODEL_SETTINGS_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  ]);
}

const NO_MODEL_SETTINGS_KEY = claudeModelSettingsKey({});

class ClaudeModelSettingsReadError extends Schema.TaggedError<ClaudeModelSettingsReadError>()(
  "ClaudeModelSettingsReadError",
  { cause: Schema.Defect() },
) {}

export const resolveClaudeModelSettingsKey = Effect.fn("resolveClaudeModelSettingsKey")(function* (
  settingSources: ReadonlyArray<SettingSource>,
  cwd: string | null,
) {
  // The SDK reads the local file from cwd, Claude Code from the main checkout's root. No key, so
  // no routes, when that root file touches model settings.
  const localDirectory = cwd === null ? null : yield* claudeLocalSettingsDirectory(cwd);
  if (localDirectory !== null && localDirectory !== cwd) {
    const rootLocal = yield* Effect.tryPromise({
      try: () => resolveClaudeSettings({ cwd: localDirectory, settingSources: ["local"] }),
      catch: (cause) => new ClaudeModelSettingsReadError({ cause }),
    }).pipe(
      Effect.map(({ sources }) => sources.find(({ source }) => source === "local")?.settings),
      Effect.orElseSucceed(() => undefined),
    );
    if (claudeModelSettingsKey(rootLocal ?? {}) !== NO_MODEL_SETTINGS_KEY) return undefined;
  }
  return yield* Effect.tryPromise({
    try: () =>
      resolveClaudeSettings({
        ...(cwd === null ? {} : { cwd }),
        settingSources: [...settingSources],
      }),
    catch: (cause) => new ClaudeModelSettingsReadError({ cause }),
  }).pipe(
    Effect.map(({ effective }) => claudeModelSettingsKey(effective)),
    Effect.orElseSucceed(() => undefined),
  );
});

type ReportedModel = Pick<ClaudeModelInfo, "value" | "resolvedModel">;

/**
 * Model ids from Claude Code and the gateway apply where the model settings match the probe's.
 * `settle` releases turns waiting for the first provider check.
 */
export const makeClaudeCodeModelRoutes = Effect.fn("makeClaudeCodeModelRoutes")(function* (
  settingsKey: (cwd: string | null) => Effect.Effect<string | undefined>,
  probeCwd: string,
) {
  const firstProbeSettled = yield* Deferred.make<void>();
  const reported = yield* Ref.make<{
    readonly models: ReadonlyArray<ReportedModel>;
    readonly settingsKey: string | undefined;
  }>({ models: [], settingsKey: undefined });
  const gateway = yield* Ref.make<{
    readonly ids: ReadonlySet<string>;
    readonly settingsKey: string | undefined;
  }>({ ids: new Set(), settingsKey: undefined });
  return {
    record: Effect.fn("ClaudeCodeModelRoutes.record")(function* (
      models: ReadonlyArray<ReportedModel>,
    ) {
      yield* Ref.set(reported, { models, settingsKey: yield* settingsKey(probeCwd) });
    }),
    recordGateway: Effect.fn("ClaudeCodeModelRoutes.recordGateway")(function* (
      ids: ReadonlyArray<string>,
    ) {
      yield* Ref.set(gateway, { ids: new Set(ids), settingsKey: yield* settingsKey(probeCwd) });
    }),
    settle: Deferred.succeed(firstProbeSettled, undefined).pipe(Effect.asVoid),
    route: Effect.fn("ClaudeCodeModelRoutes.route")(function* (
      base: ClaudeModelCatalog,
      cwd: string | null,
      launchSettings?: ClaudeSdkSettings,
    ) {
      // Leave room for the sequential version and capability probes before falling back once;
      // an expired wait counts as settled so later calls do not wait again.
      yield* Deferred.await(firstProbeSettled).pipe(
        Effect.timeoutOption("2 minutes"),
        Effect.andThen(Deferred.succeed(firstProbeSettled, undefined)),
      );
      if (claudeModelSettingsKey(launchSettings ?? {}) !== NO_MODEL_SETTINGS_KEY) return base;
      const { models, settingsKey: probeKey } = yield* Ref.get(reported);
      const { ids, settingsKey: gatewayKey } = yield* Ref.get(gateway);
      const routed = probeKey === undefined ? base : withClaudeCodeModelRoutes(base, models);
      if (routed === base && (ids.size === 0 || gatewayKey === undefined)) return base;
      // Project settings can point an alias at another model, so routes hold only where the
      // cwd resolves the same model settings as the probe's.
      const cwdKey = yield* settingsKey(cwd);
      const catalog = cwdKey === probeKey ? routed : base;
      return ids.size > 0 && gatewayKey !== undefined && cwdKey === gatewayKey
        ? { ...catalog, gatewayModelIds: ids }
        : catalog;
    }),
  };
});
