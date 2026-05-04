import type { PreviewScenarioEntry } from "@forma/contracts";

import type {
  PreviewControlDescriptor,
  PreviewFileSessionState,
  PreviewRuntimeSnapshot,
} from "./previewWorkspaceStore";

export function createPreviewFileSessionState(
  previewFileRelativePath: string,
  input?: Partial<Omit<PreviewFileSessionState, "previewFileRelativePath" | "updatedAt">>,
): PreviewFileSessionState {
  return {
    previewFileRelativePath,
    selectedScenarioId: input?.selectedScenarioId ?? null,
    confirmedArgOverrides: { ...input?.confirmedArgOverrides },
    draftArgOverrides: { ...input?.draftArgOverrides },
    updatedAt: new Date().toISOString(),
  };
}

export function getPreviewFileSession(
  sessionsByPreviewFilePath: Readonly<Record<string, PreviewFileSessionState>>,
  previewFileRelativePath: string | null,
): PreviewFileSessionState | null {
  if (!previewFileRelativePath) {
    return null;
  }
  return sessionsByPreviewFilePath[previewFileRelativePath] ?? null;
}

export function upsertPreviewFileSession(
  sessionsByPreviewFilePath: Readonly<Record<string, PreviewFileSessionState>>,
  previewFileRelativePath: string,
  updater: (session: PreviewFileSessionState) => PreviewFileSessionState,
): Record<string, PreviewFileSessionState> {
  const currentSession =
    sessionsByPreviewFilePath[previewFileRelativePath] ??
    createPreviewFileSessionState(previewFileRelativePath);
  return {
    ...sessionsByPreviewFilePath,
    [previewFileRelativePath]: updater(currentSession),
  };
}

export function mergePreviewControlsWithDrafts(
  controls: readonly PreviewControlDescriptor[],
  draftArgOverrides: Readonly<Record<string, unknown>>,
): PreviewControlDescriptor[] {
  return controls.map((control) =>
    Object.prototype.hasOwnProperty.call(draftArgOverrides, control.name)
      ? {
          ...control,
          value: draftArgOverrides[control.name],
        }
      : control,
  );
}

export function normalizeSelectedScenarioId(
  selectedScenarioId: string | null,
  scenarioChoices: readonly PreviewScenarioEntry[],
  fallbackScenarioId: string | null,
): string | null {
  if (selectedScenarioId && scenarioChoices.some((choice) => choice.id === selectedScenarioId)) {
    return selectedScenarioId;
  }
  if (fallbackScenarioId && scenarioChoices.some((choice) => choice.id === fallbackScenarioId)) {
    return fallbackScenarioId;
  }
  return scenarioChoices[0]?.id ?? null;
}

export function reconcileDraftArgOverrides(
  draftArgOverrides: Readonly<Record<string, unknown>>,
  confirmedArgOverrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const nextDraftArgOverrides: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(draftArgOverrides)) {
    if (!Object.is(confirmedArgOverrides[name], value)) {
      nextDraftArgOverrides[name] = value;
    }
  }
  return nextDraftArgOverrides;
}

export function buildSessionFromRuntimeSnapshot(input: {
  existingSession: PreviewFileSessionState | null;
  previewFileRelativePath: string;
  runtimeSnapshot: PreviewRuntimeSnapshot;
  confirmedArgOverrides: Record<string, unknown>;
}): PreviewFileSessionState {
  const baseSession =
    input.existingSession ?? createPreviewFileSessionState(input.previewFileRelativePath);
  return {
    ...baseSession,
    previewFileRelativePath: input.previewFileRelativePath,
    selectedScenarioId: normalizeSelectedScenarioId(
      baseSession.selectedScenarioId,
      input.runtimeSnapshot.currentScenarioChoices,
      input.runtimeSnapshot.currentScenarioId,
    ),
    confirmedArgOverrides: { ...input.confirmedArgOverrides },
    draftArgOverrides: reconcileDraftArgOverrides(
      baseSession.draftArgOverrides,
      input.confirmedArgOverrides,
    ),
    updatedAt: new Date().toISOString(),
  };
}
