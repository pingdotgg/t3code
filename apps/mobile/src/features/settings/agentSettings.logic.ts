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

/** Keep a just-saved editor addressable while its catalog refresh is in flight. */
export function selectAgentSettingsSummary<
  T extends { readonly id: string; readonly scope: string },
>(selectedKey: string | null, catalogSummary: T | null, optimisticSummary: T | null): T | null {
  return (
    catalogSummary ??
    (optimisticSummary !== null &&
    `${optimisticSummary.scope}:${optimisticSummary.id}` === selectedKey
      ? optimisticSummary
      : null)
  );
}

export function hasMatchingAgentSettingsSummary<
  T extends { readonly id: string; readonly scope: string },
>(optimisticSummary: T | null, catalogSummary: T | null): boolean {
  return (
    optimisticSummary !== null &&
    catalogSummary !== null &&
    optimisticSummary.id === catalogSummary.id &&
    optimisticSummary.scope === catalogSummary.scope
  );
}
