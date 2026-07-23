import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

type ProjectIconMaps = Pick<ServerSettings, "projectIcons" | "projectIconsByGitRemote">;

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function replaceIconInMap(
  entries: Readonly<Record<string, string>>,
  key: string,
  iconPath: string,
): Record<string, string> {
  const next = { ...entries };
  if (iconPath.length === 0) {
    delete next[key];
  } else {
    next[key] = iconPath;
  }
  return next;
}

export function applyProjectIconUpdate(
  current: ProjectIconMaps,
  update: NonNullable<ServerSettingsPatch["projectIconUpdate"]>,
): ProjectIconMaps {
  if (update.scope === "git-remote") {
    const projectIcons = { ...current.projectIcons };
    delete projectIcons[update.workspaceRoot];
    return {
      projectIcons,
      projectIconsByGitRemote: replaceIconInMap(
        current.projectIconsByGitRemote,
        update.repositoryKey,
        update.iconPath,
      ),
    };
  }

  const projectIconsByGitRemote = { ...current.projectIconsByGitRemote };
  if (update.repositoryKey) {
    delete projectIconsByGitRemote[update.repositoryKey];
  }
  return {
    projectIcons: replaceIconInMap(current.projectIcons, update.workspaceRoot, update.iconPath),
    projectIconsByGitRemote,
  };
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const { automaticGitFetchInterval, projectIconUpdate, ...patchForMerge } = patch;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacements = {
    ...next,
    ...(patch.projectIcons !== undefined ? { projectIcons: patch.projectIcons } : {}),
    ...(patch.projectIconsByGitRemote !== undefined
      ? { projectIconsByGitRemote: patch.projectIconsByGitRemote }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
  };
  const nextWithProjectIconUpdate = projectIconUpdate
    ? {
        ...nextWithReplacements,
        ...applyProjectIconUpdate(nextWithReplacements, projectIconUpdate),
      }
    : nextWithReplacements;
  if (!selectionPatch) {
    return nextWithProjectIconUpdate;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithProjectIconUpdate,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
