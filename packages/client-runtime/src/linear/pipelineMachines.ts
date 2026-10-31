import {
  resolveProjectProviderInstanceEnabled,
  type EnvironmentId,
  type PipelineDefinition,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../state/projectGrouping.ts";
import type { EnvironmentProject } from "../state/models.ts";

/** The first project per environment in the same logical group as `project`. */
export function logicalProjectCounterparts(
  project: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
  settings: ProjectGroupingSettings,
): ReadonlyMap<EnvironmentId, ProjectId> {
  const key = deriveLogicalProjectKeyFromSettings(project, settings);
  const byEnvironment = new Map<EnvironmentId, ProjectId>();
  for (const candidate of projects) {
    if (byEnvironment.has(candidate.environmentId)) continue;
    if (deriveLogicalProjectKeyFromSettings(candidate, settings) === key) {
      byEnvironment.set(candidate.environmentId, candidate.id);
    }
  }
  return byEnvironment;
}

/** One machine that can run the pipeline, with the project it runs there. */
export interface PipelineMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId;
  readonly isPrimary: boolean;
}

export interface PipelineMachineInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly connected: boolean;
  /** `capabilities.pipelines` of the machine's server. */
  readonly supportsPipelines: boolean;
  /** The machine allows `startPipelineRun` for this connection. */
  readonly canStart: boolean;
  /** The machine's counterpart of the resolved project; null when it has none. */
  readonly projectId: ProjectId | null;
}

/** Machines that can run the pipeline for the resolved project, primary first. */
export function eligiblePipelineMachines(
  inputs: ReadonlyArray<PipelineMachineInput>,
): ReadonlyArray<PipelineMachine> {
  const machines: PipelineMachine[] = [];
  for (const input of inputs) {
    if (!input.connected || !input.supportsPipelines || !input.canStart) continue;
    if (input.projectId === null) continue;
    machines.push({
      environmentId: input.environmentId,
      label: input.label,
      projectId: input.projectId,
      isPrimary: input.isPrimary,
    });
  }
  return machines.sort((a, b) =>
    a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : a.label.localeCompare(b.label),
  );
}

/** The machine control only exists when there is a real choice. */
function hasMachineChoice(machines: ReadonlyArray<PipelineMachine>): boolean {
  return machines.length >= 2;
}

/** `null` is "not chosen yet": the default applies. */
export type PipelineMachineChoice = "auto" | EnvironmentId | null;

/**
 * Auto when balancing is on and there is a choice, else the primary. A chosen machine that is no
 * longer eligible falls back to the default instead of starting somewhere unlisted.
 */
export function resolvePipelineMachineChoice(input: {
  readonly choice: PipelineMachineChoice;
  readonly machines: ReadonlyArray<PipelineMachine>;
  readonly autoOffered: boolean;
  /** Whether Auto is the default; defaults to `autoOffered`. Mobile offers Auto but defaults to the primary. */
  readonly autoByDefault?: boolean;
}): "auto" | EnvironmentId | null {
  const { choice, machines } = input;
  const autoAvailable = input.autoOffered && hasMachineChoice(machines);
  if (choice === "auto" && autoAvailable) return "auto";
  if (choice !== null && choice !== "auto") {
    if (machines.some((machine) => machine.environmentId === choice)) return choice;
  }
  if (autoAvailable && (input.autoByDefault ?? true)) return "auto";
  return (machines.find((machine) => machine.isPrimary) ?? machines[0])?.environmentId ?? null;
}

/** Whether a step's provider instance can take a turn on the machine, as the composer decides it. */
function providerInstanceReady(input: {
  readonly provider: ServerProvider;
  readonly settings: ServerSettings | null;
  readonly projectId: ProjectId;
}): boolean {
  const { provider } = input;
  const enabled = input.settings
    ? resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId)
    : provider.enabled;
  return (
    enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
  );
}

/** Every provider instance the pipeline's steps use is ready on the machine. */
export function pipelineProvidersReady(input: {
  readonly pipeline: Pick<PipelineDefinition, "steps"> | null;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly settings: ServerSettings | null;
  readonly projectId: ProjectId;
}): boolean {
  if (input.pipeline === null) return true;
  const providers = input.providers ?? [];
  return input.pipeline.steps.every((step) =>
    providers.some(
      (provider) =>
        provider.instanceId === step.modelSelection.instanceId &&
        providerInstanceReady({ provider, settings: input.settings, projectId: input.projectId }),
    ),
  );
}

/**
 * The machines Auto may pick from: weight above 0 (web "Manual only" machines are excluded) and the
 * pipeline's providers ready. Equal weights when `weights` has no entry, as on mobile.
 */
export function autoBalanceCandidates(input: {
  readonly machines: ReadonlyArray<PipelineMachine>;
  readonly weights: Readonly<Record<string, number>>;
  readonly defaultWeight: number;
  readonly providersReady: (machine: PipelineMachine) => boolean;
}): ReadonlyArray<EnvironmentId> {
  return input.machines
    .filter(
      (machine) =>
        (input.weights[machine.environmentId] ?? input.defaultWeight) > 0 &&
        input.providersReady(machine),
    )
    .map((machine) => machine.environmentId);
}

export type AutoMachineState =
  | { readonly kind: "checking" }
  | { readonly kind: "picked"; readonly environmentId: EnvironmentId }
  | { readonly kind: "unavailable" };

/** What the control shows for Auto: a latched pick wins over later resource reads. */
export function resolveAutoMachineState(input: {
  readonly latched: EnvironmentId | null;
  readonly pending: boolean;
  readonly picked: EnvironmentId | null;
  readonly candidateCount: number;
}): AutoMachineState {
  if (input.latched !== null) return { kind: "picked", environmentId: input.latched };
  if (input.candidateCount === 0) return { kind: "unavailable" };
  if (input.pending) return { kind: "checking" };
  return input.picked === null
    ? { kind: "unavailable" }
    : { kind: "picked", environmentId: input.picked };
}

/** Keeps the pipeline the person picked, by name, when they switch machine. */
export function resolvePipelineSelection<
  P extends { readonly id: string; readonly name: string },
>(input: {
  readonly pipelines: ReadonlyArray<P>;
  /** The pick on screen; ids differ per machine, names do not. */
  readonly chosenName: string | null;
  /** The pipeline the launch entry point asked for, by name. */
  readonly requestedName: string | null;
  readonly lastUsedName: string | null;
}): { readonly pipeline: P | null; readonly unmatchedName: string | null } {
  const byName = (name: string | null) =>
    name === null ? undefined : input.pipelines.find((candidate) => candidate.name === name);
  const chosen = byName(input.chosenName);
  const pipeline =
    chosen ?? byName(input.requestedName) ?? byName(input.lastUsedName) ?? input.pipelines[0];
  return {
    pipeline: pipeline ?? null,
    unmatchedName:
      input.chosenName !== null && chosen === undefined && input.pipelines.length > 0
        ? input.chosenName
        : null,
  };
}

export type LinearWriteBackRoute =
  /** The run is on the machine that serves Linear: unchanged. */
  | { readonly kind: "primary"; readonly recordOn: EnvironmentId }
  /** The run's machine has the same Linear workspace connected and keeps the link itself. */
  | { readonly kind: "seamless"; readonly recordOn: EnvironmentId }
  /** The primary records the launch and notes the machine; the comment is never updated. */
  | { readonly kind: "fallback"; readonly recordOn: EnvironmentId; readonly machineName: string };

/**
 * Exactly one machine records a launch. The run's machine does when it is connected to the same
 * Linear organization as the primary; otherwise the primary does and remembers where the run is.
 */
export function resolveLinearWriteBackRoute(input: {
  readonly runEnvironmentId: EnvironmentId;
  readonly runMachineName: string;
  readonly primaryEnvironmentId: EnvironmentId;
  readonly primaryOrganizationId: string | null;
  /** The run machine's Linear connection; null when unknown or unreadable. */
  readonly runLinear: {
    readonly state: string;
    readonly organizationId: string | null;
  } | null;
}): LinearWriteBackRoute {
  if (input.runEnvironmentId === input.primaryEnvironmentId) {
    return { kind: "primary", recordOn: input.primaryEnvironmentId };
  }
  const { runLinear } = input;
  if (
    runLinear !== null &&
    runLinear.state === "connected" &&
    runLinear.organizationId !== null &&
    runLinear.organizationId === input.primaryOrganizationId
  ) {
    return { kind: "seamless", recordOn: input.runEnvironmentId };
  }
  return {
    kind: "fallback",
    recordOn: input.primaryEnvironmentId,
    machineName: input.runMachineName,
  };
}

/** The dialog's comment row text, which says up front when the comment will not be updated. */
export function pipelineCommentDescription(route: LinearWriteBackRoute): string {
  return route.kind === "fallback"
    ? `One comment with a link (not updated: ${route.machineName} has no matching Linear connection)`
    : "One comment with a link, updated as each step finishes";
}
