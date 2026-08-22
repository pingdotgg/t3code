export function isMissingPortForwardEnvironment(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "EnvironmentNotRegisteredError"
  );
}

export function isRejectedPortForwardAuthorization(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "EnvironmentAuthInvalidError"
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

  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    switch (cause._tag) {
      case "EnvironmentAuthInvalidError":
        return "The environment authorization expired or was rejected after reconnecting.";
      case "EnvironmentScopeRequiredError":
        return "Port forwarding requires terminal access on this environment.";
      case "EnvironmentInternalError":
        return "The environment could not issue a port-forward connection ticket.";
    }
  }

  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause.trim();
  }

  return "The environment could not authorize this connection.";
}
