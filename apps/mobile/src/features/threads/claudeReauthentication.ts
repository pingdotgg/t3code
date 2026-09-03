export function isClaudeAuthenticationError(input: {
  readonly errorClass?: string;
  readonly providerName?: string | null;
  readonly providerDriver?: string | null;
}): boolean {
  return (
    input.errorClass === "auth_error" &&
    (input.providerName === "claudeAgent" || input.providerDriver === "claudeAgent")
  );
}
