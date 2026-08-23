const AGY_REASONING_EFFORT_SUFFIX = /^(.*)-(low|medium|high)$/;

export function resolveAgyModelForEffort(
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  if (!model || !effort) return model;

  const match = AGY_REASONING_EFFORT_SUFFIX.exec(model);
  return match?.[1] ? `${match[1]}-${effort}` : model;
}
