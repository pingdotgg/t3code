import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ThreadId,
  type HostApplicationDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";

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
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly hostApplication: HostApplicationDescriptor | null;
  readonly hostVersionStatus: "unknown" | "legacy" | "known";
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
