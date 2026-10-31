import { useAtomValue } from "@effect/atom-react";
import {
  autoBalanceCandidates,
  eligiblePipelineMachines,
  logicalProjectCounterparts,
  pipelineProvidersReady,
  resolveAutoMachineState,
  resolvePipelineMachineChoice,
  type PipelineMachine,
  type PipelineMachineChoice,
} from "@t3tools/client-runtime/linear/pipeline-machines";
import { DEFAULT_LOAD_BALANCING_WEIGHT } from "@t3tools/client-runtime/state/host-resources-balancing";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, PipelineDefinition } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";

// A primitive key, so config pushes that leave the answer alone do not re-render the dialog.
const startableEnvironmentsAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom)]
    .filter(
      ([environmentId, config]) =>
        config.environment.capabilities.pipelines === true &&
        get(serverEnvironment.startPipelineRun.permissionAtom(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .join("\n"),
).pipe(Atom.withLabel("web-linear-pipeline-startable-environments"));

/** Machines that can run the pipeline for the resolved project, and which one the person picked. */
export function useLinearPipelineMachines(
  primaryEnvironmentId: EnvironmentId,
  project: EnvironmentProject | null,
) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const loadBalancingEnabled = useClientSettings((settings) => settings.loadBalancingEnabled);
  const hydrated = useClientSettingsHydrated();
  const startable = new Set(useAtomValue(startableEnvironmentsAtom).split("\n"));
  const [choice, setChoice] = useState<PipelineMachineChoice>(null);
  const [latched, setLatched] = useState<EnvironmentId | null>(null);

  const counterparts =
    project === null ? null : logicalProjectCounterparts(project, projects, groupingSettings);
  const machines = eligiblePipelineMachines(
    environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      isPrimary: environment.environmentId === primaryEnvironmentId,
      connected: environment.connection.phase === "connected",
      supportsPipelines: startable.has(environment.environmentId),
      canStart: startable.has(environment.environmentId),
      projectId: counterparts?.get(environment.environmentId) ?? null,
    })),
  );
  const autoOffered = hydrated && loadBalancingEnabled;
  const effective = resolvePipelineMachineChoice({ choice, machines, autoOffered });
  const live =
    latched !== null && machines.some((machine) => machine.environmentId === latched)
      ? latched
      : null;
  // The pipeline list follows the picked machine; until Auto picks one it shows the primary's.
  const listEnvironmentId =
    effective === "auto" ? (live ?? primaryEnvironmentId) : (effective ?? primaryEnvironmentId);
  return {
    machines,
    autoOffered: autoOffered && machines.length >= 2,
    effective,
    live,
    listEnvironmentId,
    choose: (next: "auto" | EnvironmentId) => {
      setLatched(null);
      setChoice(next);
    },
    latch: setLatched,
  };
}

/**
 * Auto balance for the dialog: polls host resources only while Auto is unresolved, then keeps the
 * pick until the person chooses Auto again.
 */
export function useLinearAutoMachine(input: {
  readonly machines: ReadonlyArray<PipelineMachine>;
  readonly active: boolean;
  readonly live: EnvironmentId | null;
  readonly pipeline: Pick<PipelineDefinition, "steps"> | null;
  readonly latch: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const weights = useClientSettings((settings) => settings.loadBalancingWeights);
  const environmentById = new Map(environments.map((entry) => [entry.environmentId, entry]));
  const needsPick = input.active && input.live === null;
  const candidates = needsPick
    ? autoBalanceCandidates({
        machines: input.machines,
        weights,
        defaultWeight: DEFAULT_LOAD_BALANCING_WEIGHT,
        providersReady: (machine) =>
          pipelineProvidersReady({
            pipeline: input.pipeline,
            providers: providersByEnvironment.get(machine.environmentId),
            settings: environmentById.get(machine.environmentId)?.serverConfig?.settings ?? null,
            projectId: machine.projectId,
          }),
      })
    : [];
  const balanced = useLoadBalancedEnvironment(candidates, weights);
  const { latch } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the first settled pick so later resource pushes do not move the run
  useEffect(() => {
    if (needsPick && !balanced.pending && balanced.environmentId !== null) {
      latch(balanced.environmentId);
    }
  }, [needsPick, balanced.pending, balanced.environmentId, latch]);
  return {
    state: resolveAutoMachineState({
      latched: input.live,
      pending: balanced.pending,
      picked: balanced.environmentId,
      candidateCount: candidates.length,
    }),
    recheck: () => balanced.refresh(input.machines.map((machine) => machine.environmentId)),
  };
}
