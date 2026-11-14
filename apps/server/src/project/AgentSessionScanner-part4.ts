
import {
  AgentSessionScanError,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type AgentSessionImportSource,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { AgentSessionScanner, MAX_DISCOVERY_OPERATIONS_PER_SOURCE, MAX_METADATA_BYTES_PER_SOURCE, MAX_METADATA_OPERATIONS_PER_SOURCE, MAX_METADATA_RECORDS_PER_SOURCE, MAX_TRANSCRIPTS_PER_SOURCE, decodeClaudeSettings, decodeCodexSettings, selectMetadataTranscripts } from "./AgentSessionScanner.ts";
import type { MetadataReadBudget, RawCandidate, TranscriptCandidate } from "./AgentSessionScanner.ts";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolvePiSessionsDir } from "@t3tools/provider-pi/server/usage";

import type { makeAgentSessionScannerState } from "./AgentSessionScanner-part3.ts";

type State = Effect.Success<ReturnType<typeof makeAgentSessionScannerState>>;

export const makeAgentSessionScannerStage2 = Effect.fn("makeAgentSessionScannerStage2")(function* (state: State) {
  const {
    fileSystem,
    processRunner,
    importReadLock,
    path,
    serverConfig,
    serverSettings,
    projectStore,
    baseDir,
    worktreesDir,
    isWindows,
    foldWorktreeCase,
    hostEnvironment,
    homeDir,
    excludedProjectRoots,
    excludedProjectAncestors,
    isExcludedProjectPath,
    listDirectory,
    statOption,
    directoryIdentity,
    blockedGitFilePaths,
    readGitFiles,
    readGitIdentities,
    readCwd,
    readTranscript,
    readCodexThreadNames,
    resolveClaudeConfigDir,
    discoverClaudeTranscripts,
    discoverCodexTranscripts,
    discoverPiTranscripts,
    groupTranscriptsByCwd,
  } = state;
  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const raw: Array<RawCandidate> = [];
    let truncated = false;

    for (const source of ["claudeAgent", "codex", "pi"] as const) {
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(
          ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
        )
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      if (!Object.hasOwn(settings.providerInstances, source)) {
        const defaultInstance = {
          instanceId: ProviderInstanceId.make(source),
          config: { driver: ProviderDriverKind.make(source) },
        };
        if (resolveProviderInstanceEnabled(defaultInstance.config)) {
          instances.push(defaultInstance);
        }
      }

      instances.sort((left, right) => {
        const leftDefault = left.instanceId === source ? 0 : 1;
        const rightDefault = right.instanceId === source ? 0 : 1;
        return leftDefault - rightDefault;
      });
      const homes: Array<{ homePath: string; providerInstanceId: ProviderInstanceId }> = [];
      const seenHomes = new Set<string>();
      for (const { instanceId, config: instance } of instances) {
        const environmentHome = (name: "CLAUDE_CONFIG_DIR" | "CODEX_HOME") => {
          const configured = instance.environment?.findLast(
            (variable) => variable.name === name,
          )?.value;
          return typeof configured === "string" ? configured : hostEnvironment[name];
        };

        let homePath: string;
        if (source === "pi") {
          const environment = yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ).pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
          homePath = resolvePiSessionsDir(environment, homeDir, path);
        } else if (source === "claudeAgent") {
          const config = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          homePath = resolveClaudeConfigDir(
            config.value.homePath,
            environmentHome("CLAUDE_CONFIG_DIR"),
          );
        } else {
          const config = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          const codexHome = environmentHome("CODEX_HOME");
          const codexSettings =
            config.value.homePath.trim().length === 0 &&
            config.value.shadowHomePath.trim().length === 0 &&
            codexHome?.trim()
              ? { ...config.value, homePath: codexHome }
              : config.value;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          homePath = layout.sharedHomePath;
        }

        const homeKey = `${source}\0${yield* directoryIdentity(homePath)}`;
        if (seenHomes.has(homeKey)) continue;
        seenHomes.add(homeKey);
        homes.push({ homePath, providerInstanceId: instanceId });
      }

      const transcriptCandidates: Array<TranscriptCandidate> = [];
      const baseOperationBudget = Math.floor(
        MAX_DISCOVERY_OPERATIONS_PER_SOURCE / Math.max(1, homes.length),
      );
      const extraOperationBudgets = MAX_DISCOVERY_OPERATIONS_PER_SOURCE % Math.max(1, homes.length);
      for (const [index, home] of homes.entries()) {
        const operationBudget = baseOperationBudget + (index < extraOperationBudgets ? 1 : 0);
        if (operationBudget === 0) {
          truncated = true;
          continue;
        }
        const discover =
          source === "claudeAgent"
            ? discoverClaudeTranscripts
            : source === "codex"
              ? discoverCodexTranscripts
              : discoverPiTranscripts;
        const discovered = yield* discover(home.homePath, home.providerInstanceId, operationBudget);
        truncated ||= discovered.truncated;
        transcriptCandidates.push(...discovered.transcripts);
      }

      transcriptCandidates.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
      );
      if (transcriptCandidates.length > MAX_TRANSCRIPTS_PER_SOURCE) {
        truncated = true;
      }
      const selectedTranscripts = selectMetadataTranscripts(transcriptCandidates);
      const metadataBudget: MetadataReadBudget = {
        bytesRemaining: MAX_METADATA_BYTES_PER_SOURCE,
        operationsRemaining: MAX_METADATA_OPERATIONS_PER_SOURCE,
        recordsRemaining: MAX_METADATA_RECORDS_PER_SOURCE,
        truncated: false,
      };
      raw.push(...(yield* groupTranscriptsByCwd(source, selectedTranscripts, metadataBudget)));
      truncated ||= metadataBudget.truncated;
    }

    return { candidates: raw, truncated };
  });

  const cachedCandidates = { value: null as ReadonlyArray<RawCandidate> | null };

  return {
    ...state,
    collectCandidates,
    cachedCandidates,
  };
});
