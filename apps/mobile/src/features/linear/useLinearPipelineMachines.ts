import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  autoBalanceCandidates,
  eligiblePipelineMachines,
  logicalProjectCounterparts,
  pipelineInstanceIds,
  pipelineProvidersReady,
  resolveAutoMachineState,
  resolvePipelineMachineChoice,
  type PipelineMachine,
  type PipelineMachineChoice,
} from "@t3tools/client-runtime/linear/pipeline-machines";
import {
  createHostResourcesAtom,
  DEFAULT_LOAD_BALANCING_WEIGHT,
  selectLoadBalancedFromHostResources,
} from "@t3tools/client-runtime/state/host-resources-balancing";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, PipelineDefinition } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";

const hostResourcesAtom = createHostResourcesAtom(serverEnvironment.hostResources);

// A primitive key, so config pushes that leave the answer alone do not re-render the sheet.
const startableEnvironmentsAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom)]
    .filter(
      ([environmentId, config]) =>
        config.environment.capabilities.pipelines === true &&
        get(serverEnvironment.startPipelineRun.permissionAtom(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .join("\n"),
).pipe(Atom.withLabel("mobile-linear-pipeline-startable-environments"));

const remoteLinksAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
        .linearRemoteLinks === true,
  ).pipe(Atom.withLabel("mobile-linear-remote-links")),
);

/**
 * Machines that can run the pipeline for the resolved project. Auto balance is offered with two or
 * more, but the primary stays the default: mobile has no load-balancing preferences.
 */
export function useLinearPipelineMachines(
  primaryEnvironmentId: EnvironmentId,
  project: EnvironmentProject | null,
) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const groupingSettings = useMobileProjectGroupingSettings();
  const startable = new Set(useAtomValue(startableEnvironmentsAtom).split("\n"));
  const primarySupportsRemoteLinks = useAtomValue(remoteLinksAtom(primaryEnvironmentId));
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
  const effective = resolvePipelineMachineChoice({
    choice,
    machines,
    autoOffered: true,
    autoByDefault: false,
  });
  const live =
    latched !== null && machines.some((machine) => machine.environmentId === latched)
      ? latched
      : null;
  // The pipeline list follows the picked machine; until Auto picks one it shows the primary's.
  const listEnvironmentId =
    effective === "auto" ? (live ?? primaryEnvironmentId) : (effective ?? primaryEnvironmentId);
  return {
    machines,
    primarySupportsRemoteLinks,
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

const NO_WEIGHTS: Readonly<Record<string, number>> = {};

/**
 * Auto balance with equal weights: polls host resources only while Auto is unresolved, then keeps
 * the pick until the person chooses Auto again.
 */
export function useLinearAutoMachine(input: {
  readonly machines: ReadonlyArray<PipelineMachine>;
  readonly active: boolean;
  readonly live: EnvironmentId | null;
  /** False until the listed machine's pipelines load. */
  readonly pipelineKnown: boolean;
  readonly pipeline: Pick<PipelineDefinition, "steps"> | null;
  readonly latch: (environmentId: EnvironmentId) => void;
}) {
  const registry = useContext(RegistryContext);
  const configs = useServerConfigs();
  const needsPick = input.active && input.live === null && input.pipelineKnown;
  const instanceIds = pipelineInstanceIds(input.pipeline);
  const candidates = needsPick
    ? autoBalanceCandidates({
        machines: input.machines,
        weights: NO_WEIGHTS,
        defaultWeight: DEFAULT_LOAD_BALANCING_WEIGHT,
        providersReady: (machine) => {
          const config = configs.get(machine.environmentId);
          return pipelineProvidersReady({
            instanceIds,
            providers: config?.providers,
            settings: config?.settings ?? null,
            projectId: machine.projectId,
          });
        },
      })
    : [];
  const snapshot = useAtomValue(hostResourcesAtom(candidates.join("\n")));
  const balanced = selectLoadBalancedFromHostResources(snapshot, NO_WEIGHTS);
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
      pipelineKnown: input.pipelineKnown,
      pending: balanced.pending,
      picked: balanced.environmentId,
      candidateCount: candidates.length,
    }),
    recheck: () => {
      for (const machine of input.machines) {
        registry.refresh(
          serverEnvironment.hostResources({ environmentId: machine.environmentId, input: {} }),
        );
      }
    },
  };
}
