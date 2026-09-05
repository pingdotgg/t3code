export type GatewayScope = "read" | "create" | "send";

export interface GatewayProfile {
  readonly name: string;
  readonly environmentId: string;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly instanceId: string;
  readonly model: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode: "default" | "plan";
}

export interface GatewayEnvironmentSummary {
  readonly environmentId: string;
  readonly label: string;
  readonly targetKind: string;
  readonly connectionState: string;
  readonly serverVersion?: string;
  readonly grantedScopes?: ReadonlyArray<string>;
}

export interface GatewayPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor?: string;
  readonly snapshotAt: string;
}

export interface GatewayMutationResult {
  readonly requestId: string;
  readonly commandId?: string;
  readonly status: "accepted" | "queued" | "running" | "succeeded" | "failed" | "denied";
  readonly threadId: string;
  readonly messageId?: string;
}

export interface GatewayRuntimePort {
  listEnvironments(): Promise<ReadonlyArray<GatewayEnvironmentSummary>>;
  getEnvironmentStatus(environmentId: string): Promise<Record<string, unknown>>;
  listProjects(environmentId: string): Promise<GatewayPage<Record<string, unknown>>>;
  listThreads(environmentId: string): Promise<GatewayPage<Record<string, unknown>>>;
  getThread(environmentId: string, threadId: string): Promise<Record<string, unknown>>;
  createThread(input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly title: string;
    readonly modelSelection: {
      readonly instanceId: string;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
    };
    readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode: "default" | "plan";
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  sendMessage(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly text: string;
    readonly messageId: string;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
}
