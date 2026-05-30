import type {
  EnvironmentConnection,
  EnvironmentConnectionState,
  WsRpcClient,
} from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type { EnvironmentRuntimeState } from "@t3tools/client-runtime";

export interface ConnectedEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly connectionState: EnvironmentConnectionState;
  readonly connectionError: string | null;
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface EnvironmentSession {
  readonly client: WsRpcClient;
  readonly connection: EnvironmentConnection;
}
