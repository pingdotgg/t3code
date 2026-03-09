import type { HarnessConnectorId, HarnessProfileId } from "@t3tools/contracts";

export interface ConnectorRegistration {
  readonly connectorId: HarnessConnectorId;
  readonly profileId?: HarnessProfileId;
  readonly description?: string;
  readonly version?: string;
}

export function createConnectorAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}
