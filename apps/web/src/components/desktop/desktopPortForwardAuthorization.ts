export function isMissingPortForwardEnvironment(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "EnvironmentNotRegisteredError"
  );
}

export function portForwardAuthorizationErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message.trim();
  }

  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause.trim();
  }

  return "The environment could not authorize this connection.";
}
