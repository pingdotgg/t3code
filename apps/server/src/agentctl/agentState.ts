import type { AgentctlSandboxPhase } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// The subset of `agentctl get agents -o json` T3 reads. Decoding ignores every
// other field, so newer agentctl releases that add fields keep working.

const Condition = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  lastTransitionTime: Schema.optionalKey(Schema.String),
});

const Resources = Schema.Struct({
  cpu: Schema.optionalKey(Schema.String),
  memory: Schema.optionalKey(Schema.String),
  rootFilesystem: Schema.optionalKey(
    Schema.Struct({ capacity: Schema.optionalKey(Schema.String) }),
  ),
});

const ProgressStep = Schema.Struct({ name: Schema.String });

const Progress = Schema.Struct({
  current: Schema.optionalKey(
    Schema.Struct({
      phase: Schema.Struct({ label: Schema.String }),
      steps: Schema.optionalKey(Schema.Array(ProgressStep)),
    }),
  ),
  status: Schema.optionalKey(Schema.Struct({ state: Schema.String })),
});

export const AgentResource = Schema.Struct({
  metadata: Schema.Struct({
    name: Schema.String,
    generation: Schema.optionalKey(Schema.Number),
    deletionTimestamp: Schema.optionalKey(Schema.String),
  }),
  spec: Schema.Struct({
    runState: Schema.optionalKey(Schema.String),
    access: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.String }))),
    sandbox: Schema.optionalKey(Schema.Struct({ resources: Schema.optionalKey(Resources) })),
    network: Schema.optionalKey(Schema.Struct({ mode: Schema.optionalKey(Schema.String) })),
  }),
  status: Schema.optionalKey(
    Schema.Struct({
      observedGeneration: Schema.optionalKey(Schema.Number),
      conditions: Schema.optionalKey(Schema.Array(Condition)),
      failure: Schema.optionalKey(Schema.String),
      progress: Schema.optionalKey(Schema.Struct({ progress: Progress })),
      provenance: Schema.optionalKey(
        Schema.Struct({ manifestPath: Schema.optionalKey(Schema.String) }),
      ),
      sandbox: Schema.optionalKey(
        Schema.Struct({ harnesses: Schema.optionalKey(Schema.Array(Schema.String)) }),
      ),
    }),
  ),
});
export type AgentResource = typeof AgentResource.Type;

export const AgentResourceList = Schema.Array(AgentResource);

export const SshInfo = Schema.Struct({
  workingDirectory: Schema.String,
});
export type SshInfo = typeof SshInfo.Type;

export interface AgentState {
  readonly phase: AgentctlSandboxPhase;
  readonly detail: string | null;
}

const condition = (agent: AgentResource, type: string) =>
  agent.status?.conditions?.find((candidate) => candidate.type === type);

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

function runningProgress(agent: AgentResource) {
  const progress = agent.status?.progress?.progress;
  return progress?.status?.state === "running" ? progress : undefined;
}

/** The phase in progress and its current step, as `agentctl tui` shows it. */
function progressSummary(progress: typeof Progress.Type | undefined): string | null {
  const current = progress?.current;
  if (current === undefined) return null;
  const step = current.steps?.at(-1);
  return step === undefined ? current.phase.label : `${current.phase.label} · ${step.name}`;
}

/**
 * The Agent's state, derived the way agentctl's TUI does: deletion first, then
 * a stop or start in flight, then the failure class, the pass in progress and
 * readiness. agentctl has no state field of its own.
 */
export function deriveAgentState(agent: AgentResource): AgentState {
  if (agent.metadata.deletionTimestamp !== undefined) {
    return { phase: "terminating", detail: null };
  }
  const ready = condition(agent, "Ready");
  const message = nonEmpty(ready?.message);
  const currentGeneration =
    agent.status?.observedGeneration === undefined ||
    agent.status.observedGeneration === agent.metadata.generation;
  const failure = currentGeneration ? agent.status?.failure : undefined;
  const progress = runningProgress(agent);

  if (agent.spec.runState === "Stopped") {
    const recordedStopped = currentGeneration && ready?.reason === "Stopped";
    if (recordedStopped) return { phase: "stopped", detail: null };
    if (failure === undefined) return { phase: "stopping", detail: progressSummary(progress) };
  } else if (ready?.reason === "Starting") {
    return { phase: "starting", detail: progressSummary(progress) };
  }

  if (condition(agent, "SandboxResponsive")?.status === "False") {
    return { phase: "unresponsive", detail: message };
  }
  if (failure === "invalid") return { phase: "failed", detail: message };
  if (failure !== undefined) {
    return { phase: "retrying", detail: progressSummary(progress) ?? message };
  }
  if (progress !== undefined) return { phase: "provisioning", detail: progressSummary(progress) };
  if (ready === undefined) return { phase: "pending", detail: null };
  return ready.status === "True"
    ? { phase: "ready", detail: null }
    : { phase: "starting", detail: message };
}

/** When the Agent last changed readiness, such as when it started or stopped. */
export const stateSince = (agent: AgentResource) =>
  condition(agent, "Ready")?.lastTransitionTime ?? null;

export const hasSshAccess = (agent: AgentResource) =>
  agent.spec.access?.some((access) => access.type === "ssh") ?? false;

/** Whether T3 may open an SSH connection: connecting to a Sandbox that is not Ready fails. */
export const isConnectable = (agent: AgentResource) =>
  hasSshAccess(agent) &&
  deriveAgentState(agent).phase === "ready" &&
  condition(agent, "SshReady")?.status === "True";

/** `agent.<variant>.yaml` names its variant; the base `agent.yaml` has none. */
export function manifestVariant(manifestPath: string): string | null {
  const fileName = manifestPath.split(/[\\/]/).at(-1) ?? "";
  return /^agent\.([a-z0-9]+(?:-[a-z0-9]+)*)\.ya?ml$/.exec(fileName)?.[1] ?? null;
}

/** Whether a tunnel to this Sandbox is dead: it is stopping, stopped, deleted or gone. */
export function shouldCloseTunnel(agent: AgentResource | undefined): boolean {
  if (agent === undefined) return true;
  const { phase } = deriveAgentState(agent);
  return phase === "stopping" || phase === "stopped" || phase === "terminating";
}

export const sshAliasFor = (name: string) => `agentctl-${name}`;
