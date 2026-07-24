import type { HermesGatewayConnectionState } from "@t3tools/contracts";

export const HERMES_GATEWAY_SOCKET_PATH = "/api/hermes-gateway/ws";

export function defaultHermesConnectorUrl(origin: string): string {
  return new URL(HERMES_GATEWAY_SOCKET_PATH, origin).toString();
}

export function shouldApplyHermesConnectorStatusUrl(hasLocalEdits: boolean): boolean {
  return !hasLocalEdits;
}

export function hermesGatewayStatusLabel(status: HermesGatewayConnectionState): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "upgrade-required":
      return "Upgrade required";
    case "revoked":
      return "Revoked";
    case "offline":
      return "Offline";
  }
}

export function canRemoveHermesGatewayInstance(status: HermesGatewayConnectionState): boolean {
  return status === "revoked";
}

export function isHermesInstanceNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "instance-not-found"
  );
}

export function hermesGatewayLifecycleAction(input: {
  readonly status: HermesGatewayConnectionState;
  readonly instanceNotFound: boolean;
}): "revoke" | "remove-instance" | "remove-setup" {
  if (input.instanceNotFound) return "remove-setup";
  return canRemoveHermesGatewayInstance(input.status) ? "remove-instance" : "revoke";
}

export function formatHermesLastConnected(value: string | null): string {
  if (value === null) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function messageFromUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "The Hermes gateway request failed.";
}
