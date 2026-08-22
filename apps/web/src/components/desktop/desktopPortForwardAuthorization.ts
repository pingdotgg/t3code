import { EnvironmentNotRegisteredError } from "@t3tools/client-runtime/connection";
import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isEnvironmentNotRegisteredError = Schema.is(EnvironmentNotRegisteredError);
const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);

export function isMissingPortForwardEnvironment(cause: unknown): boolean {
  return isEnvironmentNotRegisteredError(cause);
}

export function isRejectedPortForwardAuthorization(cause: unknown): boolean {
  return isEnvironmentAuthInvalidError(cause);
}

export function portForwardAuthorizationErrorMessage(cause: unknown): string {
  if (isEnvironmentAuthInvalidError(cause)) {
    return "The environment authorization expired or was rejected after reconnecting.";
  }
  if (isEnvironmentScopeRequiredError(cause)) {
    return "Port forwarding requires terminal access on this environment.";
  }
  if (isEnvironmentInternalError(cause)) {
    return "The environment could not issue a port-forward connection ticket.";
  }

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
