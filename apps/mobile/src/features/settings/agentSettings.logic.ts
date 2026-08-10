export function parseRequiredNumber(value: string, label: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required.`);
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return parsed;
}

export function agentSettingsContextKey(input: {
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly selectionKey: string | null;
  readonly generation: number;
}): string {
  return `${input.environmentId ?? ""}:${input.projectId ?? ""}:${input.selectionKey ?? ""}:${input.generation}`;
}

export function resolveAgentSettingsEnvironmentId<T extends string>(
  selectedEnvironmentId: T | null,
  availableEnvironmentIds: ReadonlyArray<T>,
): T | null {
  if (selectedEnvironmentId !== null && availableEnvironmentIds.includes(selectedEnvironmentId)) {
    return selectedEnvironmentId;
  }
  return availableEnvironmentIds[0] ?? null;
}
