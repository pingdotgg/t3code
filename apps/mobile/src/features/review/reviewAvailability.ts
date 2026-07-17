export function resolveReviewAvailability(input: {
  readonly hasEnvironmentPresentation: boolean;
  readonly isEnvironmentConnected: boolean;
  readonly hasCachedSelectedDiff: boolean;
  readonly hasAnyCachedDiff: boolean;
}): {
  readonly showConnectionNotice: boolean;
  readonly showSectionToolbar: boolean;
} {
  const showConnectionNotice =
    input.hasEnvironmentPresentation &&
    !input.isEnvironmentConnected &&
    !input.hasCachedSelectedDiff;

  return {
    showConnectionNotice,
    showSectionToolbar: !showConnectionNotice || input.hasAnyCachedDiff,
  };
}
