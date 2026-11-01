import {
  resolveSettings as resolveClaudeSettings,
  type SettingSource,
  type Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { claudeLocalSettingsDirectory } from "./Drivers/ClaudeHome.ts";
import {
  type ClaudeCodeReportedModel,
  type ClaudeModelCatalog,
  withClaudeCodeModelRoutes,
} from "./ClaudeModelCatalog.ts";

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

export const resolveClaudeModelSettingsKey = Effect.fn("resolveClaudeModelSettingsKey")(function* (
  settingSources: ReadonlyArray<SettingSource>,
  cwd: string | null,
) {
  // The SDK reads the local file from cwd, Claude Code from the main checkout's root. No key, so
  // no routes, when that root file touches model settings.
  const localDirectory = cwd === null ? null : yield* claudeLocalSettingsDirectory(cwd);
  if (localDirectory !== null && localDirectory !== cwd) {
    const rootLocal = yield* Effect.tryPromise(() =>
      resolveClaudeSettings({ cwd: localDirectory, settingSources: ["local"] }),
    ).pipe(
      Effect.map(({ sources }) => sources.find(({ source }) => source === "local")?.settings),
      Effect.orElseSucceed(() => undefined),
    );
    if (claudeModelSettingsKey(rootLocal ?? {}) !== NO_MODEL_SETTINGS_KEY) return undefined;
  }
  return yield* Effect.tryPromise(() =>
    resolveClaudeSettings({
      ...(cwd === null ? {} : { cwd }),
      settingSources: [...settingSources],
    }),
  ).pipe(
    Effect.map(({ effective }) => claudeModelSettingsKey(effective)),
    Effect.orElseSucceed(() => undefined),
  );
});

/**
 * Claude Code's reported model ids, applied to a turn only where its cwd resolves model settings
 * as the probe's cwd did. `settle` releases turns waiting for the first probe, whatever its outcome.
 */
export const makeClaudeCodeModelRoutes = Effect.fn("makeClaudeCodeModelRoutes")(function* (
  catalog: Effect.Effect<ClaudeModelCatalog>,
  settingsKey: (cwd: string | null) => Effect.Effect<string | undefined>,
  probeCwd: string,
) {
  const firstProbeSettled = yield* Deferred.make<void>();
  const reported = yield* Ref.make<{
    readonly models: ReadonlyArray<ClaudeCodeReportedModel>;
    readonly settingsKey: string | undefined;
  }>({ models: [], settingsKey: undefined });
  return {
    record: Effect.fn("ClaudeCodeModelRoutes.record")(function* (
      models: ReadonlyArray<ClaudeCodeReportedModel>,
    ) {
      yield* Ref.set(reported, { models, settingsKey: yield* settingsKey(probeCwd) });
    }),
    settle: Deferred.succeed(firstProbeSettled, undefined).pipe(Effect.asVoid),
    catalogFor: Effect.fn("ClaudeCodeModelRoutes.catalogFor")(function* (cwd: string | null) {
      // Leave room for the sequential version and capability probes before falling back.
      yield* Deferred.await(firstProbeSettled).pipe(Effect.timeoutOption("2 minutes"));
      const base = yield* catalog;
      const { models, settingsKey: probeKey } = yield* Ref.get(reported);
      const routed = withClaudeCodeModelRoutes(base, models);
      // Project settings can point an alias at another model, so routes hold only where the
      // cwd resolves the same model settings as the probe's.
      if (routed === base || probeKey === undefined) return base;
      return (yield* settingsKey(cwd)) === probeKey ? routed : base;
    }),
  };
});
