/**
 * Computer History server helpers: context injection for all providers and a
 * background summarization loop when running in desktop mode.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import {
  defaultCodexHome,
  buildComputerHistoryContextBlock,
  loadRecentContextMarkdown,
  resolveComputerHistoryRoot,
  runSummarizationPass,
  writeControlFile,
} from "@t3tools/shared/computerHistory";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

export const loadComputerHistoryContext = Effect.fn("computerHistory.loadContext")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const snapshot = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (!snapshot?.computerHistory.enabled || snapshot.computerHistory.paused) {
    return undefined;
  }
  const root = resolveComputerHistoryRoot(config.stateDir);
  const markdown = yield* Effect.tryPromise(() => loadRecentContextMarkdown(root)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (!markdown) return undefined;
  return buildComputerHistoryContextBlock(markdown);
});

/**
 * Adapter-local load: capture `ServerConfig` / `ServerSettingsService` at
 * construction so `sendTurn` keeps `R = never` while every provider can inject
 * the same Computer History block.
 */
export const loadComputerHistoryContextProvided = (
  serverConfig: ServerConfig.ServerConfig["Service"],
  serverSettings: ServerSettings.ServerSettingsService["Service"],
) =>
  loadComputerHistoryContext().pipe(
    Effect.provideService(ServerConfig.ServerConfig, serverConfig),
    Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
    Effect.orElseSucceed((): string | undefined => undefined),
  );

export const syncComputerHistoryControl = Effect.fn("computerHistory.syncControl")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const snapshot = yield* settings.getSettings;
  const history = snapshot.computerHistory;
  const root = resolveComputerHistoryRoot(config.stateDir);
  yield* Effect.tryPromise(() =>
    writeControlFile(root, {
      enabled: history.enabled,
      paused: history.paused,
      appFilterMode: history.appFilterMode,
      apps: [...history.apps],
      websiteFilterMode: history.websiteFilterMode,
      websites: [...history.websites],
    }),
  ).pipe(Effect.ignore);
});

export const runComputerHistorySummarization = Effect.fn("computerHistory.summarize")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const snapshot = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (!snapshot?.computerHistory.enabled) {
    return { created: 0 };
  }
  const root = resolveComputerHistoryRoot(config.stateDir);
  const codexHome = defaultCodexHome();
  return yield* Effect.tryPromise(() =>
    runSummarizationPass(root, {
      mirrorToCodex: snapshot.computerHistory.mirrorToCodex,
      codexHome,
    }),
  ).pipe(Effect.orElseSucceed(() => ({ created: 0 })));
});

/**
 * Fork a lightweight loop that syncs control.json and summarizes segments.
 * Safe to install in any runtime; no-ops when Computer History is disabled.
 *
 * Canonical export is `layer` (same convention as BackgroundPolicy / UsageService).
 * Callers acquire state via `ServerConfig` / `ServerSettingsService` — never via
 * process.env globals.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* syncComputerHistoryControl().pipe(Effect.ignore);
    yield* runComputerHistorySummarization().pipe(Effect.ignore);

    yield* Effect.repeat(
      Effect.gen(function* () {
        yield* syncComputerHistoryControl().pipe(Effect.ignore);
        yield* runComputerHistorySummarization().pipe(Effect.ignore);
      }),
      Schedule.spaced(Duration.minutes(1)),
    ).pipe(Effect.forkScoped);
  }),
);
