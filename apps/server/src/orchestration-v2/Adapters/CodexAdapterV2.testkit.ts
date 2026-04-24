import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import { Effect, Layer, Schema } from "effect";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterOpenSessionError } from "../ProviderAdapter.ts";
import { layerFromProviderAdapter } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { CodexAppServerClientFactory, layer as codexAdapterLayer } from "./CodexAdapterV2.ts";

export class CodexReplayTranscriptDecodeError extends Schema.TaggedErrorClass<CodexReplayTranscriptDecodeError>()(
  "CodexReplayTranscriptDecodeError",
  {
    provider: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to decode Codex app-server replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export const CodexOrchestratorReplayHarnessError = Schema.Union([
  CodexReplayTranscriptDecodeError,
  CodexReplay.CodexAppServerReplayError,
]);
export type CodexOrchestratorReplayHarnessError = typeof CodexOrchestratorReplayHarnessError.Type;

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

function makeReplayServerConfig(scenario: string): ServerConfigShape {
  const baseDir = mkdtempSync(path.join(tmpdir(), `t3-orchestration-v2-codex-${scenario}-`));
  const stateDir = path.join(baseDir, "userdata");
  const logsDir = path.join(stateDir, "logs");
  const providerLogsDir = path.join(logsDir, "provider");
  const terminalLogsDir = path.join(logsDir, "terminals");
  const attachmentsDir = path.join(stateDir, "attachments");
  const worktreesDir = path.join(baseDir, "worktrees");
  const providerStatusCacheDir = path.join(baseDir, "caches");

  for (const directory of [
    stateDir,
    logsDir,
    providerLogsDir,
    terminalLogsDir,
    attachmentsDir,
    worktreesDir,
    providerStatusCacheDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    stateDir,
    dbPath: path.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    settingsPath: path.join(stateDir, "settings.json"),
    providerStatusCacheDir,
    worktreesDir,
    attachmentsDir,
    logsDir,
    serverLogPath: path.join(logsDir, "server.log"),
    serverTracePath: path.join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: path.join(providerLogsDir, "events.log"),
    terminalLogsDir,
    anonymousIdPath: path.join(stateDir, "anonymous-id"),
    environmentIdPath: path.join(stateDir, "environment-id"),
    serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
    secretsDir: path.join(stateDir, "secrets"),
  };
}

export function makeCodexProviderAdapterRegistryReplayLayer(input: {
  readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
  readonly driver?: CodexReplay.CodexAppServerReplayDriver;
}) {
  const replayLayer =
    input.driver === undefined
      ? CodexReplay.layerReplay(input.transcript)
      : CodexReplay.layerReplayWithDriver(input.driver);
  const replayClientFactoryLayer = Layer.succeed(CodexAppServerClientFactory, {
    open: (openInput) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(replayLayer).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                provider: "codex",
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        );
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
      }),
  });
  const serverConfigLayer = Layer.succeed(
    ServerConfig,
    makeReplayServerConfig(input.transcript.scenario),
  );
  const adapterLayer = codexAdapterLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        replayClientFactoryLayer,
        serverConfigLayer,
        NodeServices.layer,
        idAllocatorLayer,
      ),
    ),
  );

  return layerFromProviderAdapter.pipe(Layer.provide(adapterLayer));
}

export const CodexOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CodexReplay.CodexAppServerReplayTranscript,
  CodexOrchestratorReplayHarnessError
> = {
  provider: "codex",
  decodeTranscript: (transcript) =>
    Schema.decodeUnknownEffect(CodexReplay.CodexAppServerReplayTranscript)(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new CodexReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) => {
    return makeCodexProviderAdapterRegistryReplayLayer({ transcript });
  },
};
