import {
  type EnvironmentId,
  type PipelineDefinition,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { providerInstanceReady } from "../load-balancing.ts";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../state/projectGrouping.ts";
import type { EnvironmentProject } from "../state/models.ts";

/**
 * `project` on its own machine, and the first project in the same logical group on every other
 * machine. One repository can hold several projects, so the chosen one must win on its machine.
 */
export function logicalProjectCounterparts(
  project: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
  settings: ProjectGroupingSettings,
): ReadonlyMap<EnvironmentId, ProjectId> {
  const key = deriveLogicalProjectKeyFromSettings(project, settings);
  const byEnvironment = new Map<EnvironmentId, ProjectId>([[project.environmentId, project.id]]);
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

/** The provider instances a pipeline's steps run on. */
export function pipelineInstanceIds(
  pipeline: Pick<PipelineDefinition, "steps"> | null,
): ReadonlyArray<string> {
  return pipeline === null
    ? []
    : [...new Set(pipeline.steps.map((step) => step.modelSelection.instanceId))];
}

/** Every provider instance the pipeline's steps use is ready on the machine. */
export function pipelineProvidersReady(input: {
  readonly instanceIds: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly settings: ServerSettings | null;
  readonly projectId: ProjectId;
}): boolean {
  const providers = input.providers ?? [];
  return input.instanceIds.every((instanceId) =>
    providers.some(
      (provider) =>
        provider.instanceId === instanceId &&
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
  /** False until the pipeline list loads: provider readiness cannot be judged before. */
  readonly pipelineKnown: boolean;
  readonly pending: boolean;
  readonly picked: EnvironmentId | null;
  readonly candidateCount: number;
}): AutoMachineState {
  if (input.latched !== null) return { kind: "picked", environmentId: input.latched };
  if (!input.pipelineKnown) return { kind: "checking" };
  if (input.candidateCount === 0) return { kind: "unavailable" };
  if (input.pending) return { kind: "checking" };
  return input.picked === null
    ? { kind: "unavailable" }
    : { kind: "picked", environmentId: input.picked };
}

export interface PipelineRef {
  readonly id: string;
  readonly name: string;
}

/**
 * The pipeline to show on the selected machine. Ids differ per machine, so the pipeline on screen
 * (the person's pick, else the primary's default) is kept by name when the machine changes.
 */
export function resolvePipelineSelection<P extends PipelineRef>(input: {
  readonly pipelines: ReadonlyArray<P>;
  /** The list of the machine that serves Linear, which the launch entry point's id belongs to. */
  readonly primaryPipelines: ReadonlyArray<PipelineRef>;
  readonly chosen: PipelineRef | null;
  readonly requestedId: string | null;
  readonly lastUsedName: string | null;
}): {
  readonly pipeline: P | null;
  /** Set when the pipeline on screen is missing here and another one was selected instead. */
  readonly unmatchedName: string | null;
  /** The one pipeline to mark "Last used"; the first match when names repeat. */
  readonly lastUsedId: string | null;
} {
  const byName = <T extends PipelineRef>(list: ReadonlyArray<T>, name: string | null) =>
    name === null ? undefined : list.find((candidate) => candidate.name === name);
  const { chosen, pipelines, primaryPipelines } = input;
  const shownName =
    chosen?.name ??
    (
      primaryPipelines.find((candidate) => candidate.id === input.requestedId) ??
      byName(primaryPipelines, input.lastUsedName) ??
      primaryPipelines[0]
    )?.name ??
    null;
  const pickedId = chosen?.id ?? input.requestedId;
  const pipeline =
    (pickedId === null ? undefined : pipelines.find((candidate) => candidate.id === pickedId)) ??
    byName(pipelines, shownName) ??
    byName(pipelines, input.lastUsedName) ??
    pipelines[0] ??
    null;
  return {
    pipeline,
    unmatchedName:
      shownName !== null && pipeline !== null && pipeline.name !== shownName ? shownName : null,
    lastUsedId: byName(pipelines, input.lastUsedName)?.id ?? null,
  };
}

export type LinearWriteBackRoute =
  /** The run is on the machine that serves Linear: unchanged. */
  | { readonly kind: "primary"; readonly recordOn: EnvironmentId }
  /** The run's machine has the same Linear workspace connected and keeps the link itself. */
  | { readonly kind: "seamless"; readonly recordOn: EnvironmentId }
  /** The primary records the launch and notes the machine; the comment is never updated. */
  | { readonly kind: "fallback"; readonly recordOn: EnvironmentId; readonly machineName: string }
  /** The primary predates links to other machines, so nothing is recorded. */
  | { readonly kind: "unlinked" };

const MAX_MACHINE_NAME_LENGTH = 128;

/** Labels are free text; the link stores a bounded, non-empty, single-line name. */
function linkMachineName(label: string): string {
  const name = label.replace(/\s+/gu, " ").trim().slice(0, MAX_MACHINE_NAME_LENGTH).trim();
  return name.length > 0 ? name : "another machine";
}

/**
 * Exactly one machine records a launch. The run's machine does when it is connected to the same
 * Linear organization as the primary; otherwise the primary does and remembers where the run is.
 * Null while a Linear status is still loading, so a quick Start cannot pick the wrong machine.
 */
export function resolveLinearWriteBackRoute(input: {
  readonly runEnvironmentId: EnvironmentId;
  readonly runMachineName: string;
  readonly primaryEnvironmentId: EnvironmentId;
  readonly primaryOrganizationId: string | null;
  /** `capabilities.linearRemoteLinks` of the primary; older servers drop `remote`. */
  readonly primarySupportsRemoteLinks: boolean;
  readonly statusPending: boolean;
  /** The run machine's Linear connection; null when unknown or unreadable. */
  readonly runLinear: {
    readonly state: string;
    readonly organizationId: string | null;
  } | null;
}): LinearWriteBackRoute | null {
  if (input.runEnvironmentId === input.primaryEnvironmentId) {
    return { kind: "primary", recordOn: input.primaryEnvironmentId };
  }
  if (input.statusPending) return null;
  const { runLinear } = input;
  if (
    runLinear !== null &&
    runLinear.state === "connected" &&
    runLinear.organizationId !== null &&
    runLinear.organizationId === input.primaryOrganizationId
  ) {
    return { kind: "seamless", recordOn: input.runEnvironmentId };
  }
  if (!input.primarySupportsRemoteLinks) return { kind: "unlinked" };
  return {
    kind: "fallback",
    recordOn: input.primaryEnvironmentId,
    machineName: linkMachineName(input.runMachineName),
  };
}

/** The dialog's comment row text, which says up front when the comment will not be updated. */
export function pipelineCommentDescription(route: LinearWriteBackRoute | null): string {
  switch (route?.kind) {
    case "fallback":
      return `One comment with a link (not updated: ${route.machineName} has no matching Linear connection)`;
    case "unlinked":
      return "Unavailable: update the machine that serves Linear to link runs on other machines";
    default:
      return "One comment with a link, updated as each step finishes";
  }
}
