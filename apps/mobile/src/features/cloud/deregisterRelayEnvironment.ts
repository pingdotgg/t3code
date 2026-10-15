import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import type { EnvironmentId } from "@t3tools/contracts";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

/** Asks before removing an environment from the signed-in T3 Connect account. */
export function confirmDeregister(environment: { readonly label: string }, onConfirm: () => void) {
  const title = "Deregister server?";
  const message = `“${environment.label}” will be removed from this account. T3 Connect access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.`;
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Deregister", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Deregister", destructive: true, onConfirm });
}

/** Reports a failed deregistration, with its trace ID when the relay sent one. */
export function alertDeregisterFailure(environmentId: EnvironmentId, cause: unknown) {
  const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
  const traceId = findErrorTraceId(cause);
  console.error("[t3-connect] Could not deregister environment", {
    environmentId,
    message,
    traceId,
    cause,
  });
  Alert.alert(
    "Could not deregister server",
    traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
    traceId
      ? [
          {
            text: "Copy trace ID",
            onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
          },
          { text: "OK", style: "cancel" },
        ]
      : undefined,
  );
}
