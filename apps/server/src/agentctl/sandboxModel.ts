import {
  AgentctlSandboxSettings,
  DesktopSshEnvironmentTargetSchema,
  EnvironmentId,
  type AgentctlSandbox,
  type AgentctlSandboxAction,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  deriveAgentState,
  hasSshAccess,
  manifestVariant,
  stateSince,
  type AgentResource,
} from "./agentState.ts";

/**
 * What T3 remembers about a Sandbox it reached: the environment its server
 * reported, so a stopped Sandbox still shows up as that environment.
 */
export const SandboxRecord = Schema.Struct({
  environmentId: EnvironmentId,
  sshTarget: DesktopSshEnvironmentTargetSchema,
  /** The user's preference settings were copied into this environment once, by a client. */
  settingsSeeded: Schema.optionalKey(Schema.Boolean),
});
export type SandboxRecord = typeof SandboxRecord.Type;

/** A link this host made to a Sandbox: only a link still made at `linkedAt` is its to change. */
export const SandboxLinkRecord = Schema.Struct({
  environmentId: EnvironmentId,
  linkedAt: Schema.String,
});
export type SandboxLinkRecord = typeof SandboxLinkRecord.Type;

export const SandboxStoreDocument = Schema.Struct({
  settings: Schema.optionalKey(AgentctlSandboxSettings),
  sandboxes: Schema.optionalKey(Schema.Record(Schema.String, SandboxRecord)),
  /** By Sandbox name, and kept after the Sandbox is gone so its link can be forgotten. */
  links: Schema.optionalKey(Schema.Record(Schema.String, SandboxLinkRecord)),
});
export type SandboxStoreDocument = typeof SandboxStoreDocument.Type;

export const DEFAULT_SANDBOX_SETTINGS: AgentctlSandboxSettings = {
  manifestRoots: [],
};

/** In-memory state for one Sandbox; none of it survives a restart. */
export interface SandboxRuntime {
  /** The lifecycle request T3 is running, for as long as its agentctl call runs. */
  readonly action: AgentctlSandboxAction | null;
  /** Which request owns `action`, so an earlier one that ends late leaves it alone. */
  readonly actionId: number;
  readonly actionError: string | null;
  readonly connectError: string | null;
  /**
   * T3 reached the Sandbox's server since it last became reachable. Until
   * then it keeps checking, so a recreated Sandbox or reset T3 home is noticed.
   */
  readonly verified: boolean;
  readonly discovering: boolean;
  /**
   * The check whose result may still be recorded, unique across Sandboxes of every name; 0 once it
   * stopped being reachable, so a check from before then is dropped.
   */
  readonly check: number;
  /** When a failed check may run again, in epoch milliseconds. */
  readonly retryAt: number;
  /** Where its agents work, from `agentctl ssh-info`, once T3 reached it. */
  readonly workingDirectory: string | null;
  /** Its T3 server, forwarded to loopback, while it is reachable. */
  readonly relayUpstream: string | null;
}

export const IDLE_RUNTIME: SandboxRuntime = {
  action: null,
  actionId: 0,
  actionError: null,
  connectError: null,
  verified: false,
  discovering: false,
  check: 0,
  retryAt: 0,
  workingDirectory: null,
  relayUpstream: null,
};

/** Drops records for Sandboxes that are gone or being deleted. */
export function reconcileRecords(
  records: Readonly<Record<string, SandboxRecord>>,
  agents: ReadonlyArray<AgentResource>,
): Record<string, SandboxRecord> {
  const next: Record<string, SandboxRecord> = {};
  for (const [name, record] of Object.entries(records)) {
    const agent = agents.find((candidate) => candidate.metadata.name === name);
    if (agent === undefined || agent.metadata.deletionTimestamp !== undefined) continue;
    next[name] = record;
  }
  return next;
}

export function buildSandbox(
  agent: AgentResource,
  record: SandboxRecord | undefined,
  runtime: SandboxRuntime,
): AgentctlSandbox {
  const state = deriveAgentState(agent);
  const manifestPath = agent.status?.provenance?.manifestPath ?? null;
  const resources = agent.spec.sandbox?.resources;
  return {
    name: agent.metadata.name,
    phase: state.phase,
    detail: state.detail,
    since: stateSince(agent),
    cpu: resources?.cpu ?? null,
    memory: resources?.memory ?? null,
    disk: resources?.rootFilesystem?.capacity ?? null,
    network: agent.spec.network?.mode ?? null,
    sshAccess: hasSshAccess(agent),
    environmentId: record?.environmentId ?? null,
    settingsSeeded: record?.settingsSeeded ?? false,
    harnesses: agent.status?.sandbox?.harnesses ?? [],
    workingDirectory: runtime.workingDirectory,
    connectError: state.phase === "ready" ? runtime.connectError : null,
    action: runtime.action,
    actionError: runtime.actionError,
    manifestPath,
    variant: manifestPath === null ? null : manifestVariant(manifestPath),
  };
}
