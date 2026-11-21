import type * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";

export type AdapterInfrastructure = CursorAgentSdk.CursorAgentSdkRunner | CursorSdk.CursorSdk;

// The Agent SDK runs in a worker process whose launch lives with the adapter infrastructure.
export const layerSdk = CursorSdk.layer;
