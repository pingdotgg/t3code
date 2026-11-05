export function resolveProjectThreadCreationBranch(input: {
  readonly selectedBranch: string | null;
  readonly currentCheckoutBranch: string | null;
}): string | null {
  return input.selectedBranch ?? input.currentCheckoutBranch;
}
