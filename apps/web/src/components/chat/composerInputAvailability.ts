export function isComposerInputDisabled(input: {
  readonly approvalActive: boolean;
  readonly projectSelectionRequired: boolean;
}): boolean {
  return input.approvalActive || input.projectSelectionRequired;
}
