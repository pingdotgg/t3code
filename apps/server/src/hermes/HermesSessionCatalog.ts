import {
  type HermesGatewayCompatibility,
  type HermesGatewayStoredSessionSummary,
  HermesSessionsError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { assessHermesConnectionSecurity } from "./HermesConnectionSecurity.ts";
import { HermesGatewayClient } from "./HermesGatewayClient.ts";
import type { HermesServeConnection, HermesServeRuntimeError } from "./HermesServeRuntime.ts";

const HERMES_IMPORT_REQUIRED_CAPABILITIES = ["profile.import", "session.lifecycle"] as const;

const isHermesSessionsError = Schema.is(HermesSessionsError);

export function hermesImportCapabilityError(
  compatibility: HermesGatewayCompatibility,
): string | null {
  const available = new Set(compatibility.capabilities);
  const missing = HERMES_IMPORT_REQUIRED_CAPABILITIES.filter(
    (capability) => !available.has(capability),
  );
  if (
    compatibility.status === "supported" &&
    compatibility.inventory !== null &&
    missing.length === 0
  ) {
    return null;
  }
  return compatibility.status === "legacy" || compatibility.inventory === null
    ? "Hermes import requires an evidence-backed negotiated capability inventory."
    : `Hermes import is unavailable because the gateway did not advertise: ${missing.join(", ")}.`;
}

export interface HermesSessionCatalogSnapshot {
  readonly providerInstanceId: ProviderInstanceId;
  readonly profileKey: string;
  readonly compatibility: HermesGatewayCompatibility;
  readonly sessions: ReadonlyArray<HermesGatewayStoredSessionSummary>;
}

export interface HermesSessionCatalogShape {
  readonly profileKey: string;
  readonly importEnabled: boolean;
  readonly list: (
    limit: number,
  ) => Effect.Effect<HermesSessionCatalogSnapshot, HermesSessionsError>;
}

export function makeHermesSessionCatalog(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authToken: string | undefined;
  readonly remoteGloballyEnabled: boolean;
  readonly remoteInstanceEnabled: boolean;
  readonly remotePairingToken: string | undefined;
  readonly remoteTlsCertificateSha256: string | undefined;
  readonly profileKey: string;
  readonly importEnabled: boolean;
  readonly ensureReady?: Effect.Effect<HermesServeConnection, HermesServeRuntimeError>;
  readonly clientFactory?: (options: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => Pick<HermesGatewayClient, "connect" | "listSessions" | "close">;
}): HermesSessionCatalogShape {
  return {
    profileKey: input.profileKey,
    importEnabled: input.importEnabled,
    list: Effect.fn("HermesSessionCatalog.list")(function* (limit) {
      if (input.authToken === undefined || input.endpoint.trim().length === 0) {
        return yield* new HermesSessionsError({
          code: "provider_not_configured",
          message: "Hermes session discovery requires a configured endpoint and gateway token.",
        });
      }
      // Route discovery through the serve runtime so a managed local Hermes
      // instance is started before the gateway is contacted.
      const connection =
        input.ensureReady === undefined
          ? undefined
          : yield* input.ensureReady.pipe(
              Effect.mapError(
                (cause) =>
                  new HermesSessionsError({
                    code:
                      cause.code === "authentication_required"
                        ? "provider_not_configured"
                        : "gateway_error",
                    message: cause.message,
                    cause,
                  }),
              ),
            );
      const security = assessHermesConnectionSecurity({
        endpoint: connection?.endpoint ?? input.endpoint,
        gatewayToken: connection?.authToken ?? input.authToken,
        remoteGloballyEnabled: input.remoteGloballyEnabled,
        remoteInstanceEnabled: input.remoteInstanceEnabled,
        remotePairingToken: input.remotePairingToken,
        remoteTlsCertificateSha256: input.remoteTlsCertificateSha256,
      });
      if (security.status !== "ready") {
        return yield* new HermesSessionsError({
          code: "provider_not_configured",
          message: "Hermes session discovery is blocked by the gateway connection policy.",
          cause: security,
        });
      }
      const client =
        input.clientFactory?.({ endpoint: security.endpoint, authToken: security.authToken }) ??
        new HermesGatewayClient({
          endpoint: security.endpoint,
          authToken: security.authToken,
        });
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const compatibility = await client.connect();
            const capabilityError = hermesImportCapabilityError(compatibility);
            if (capabilityError !== null) {
              throw new HermesSessionsError({
                code: "import_failed",
                message: capabilityError,
              });
            }
            const result = await client.listSessions({
              profile: input.profileKey,
              limit,
            });
            return {
              providerInstanceId: input.providerInstanceId,
              profileKey: input.profileKey,
              compatibility,
              sessions: result.sessions,
            };
          } finally {
            client.close();
          }
        },
        catch: (cause) =>
          isHermesSessionsError(cause)
            ? cause
            : new HermesSessionsError({
                code: "gateway_error",
                message: "Hermes session discovery failed.",
                cause,
              }),
      });
    }),
  };
}
