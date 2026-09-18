import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";

export interface EnvironmentRuntimeState {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly serverConfig: ServerConfig | null;
}

export interface ConnectedEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  /** False when the user switched the environment off in Settings. */
  readonly isEnabled: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

/** Fields a user can change on a saved pairing. Omitted route fields keep their saved value. */
export interface EnvironmentUpdateInput {
  readonly label: string;
  readonly displayUrl: string;
  readonly alternateHttpBaseUrls?: ReadonlyArray<string>;
  readonly pinnedRoute?: boolean;
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
