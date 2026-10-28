import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PipelineDefinition, PipelineId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { draftPipelineSelectionAtom } from "./chatViewSend";
import { activeDraftPipelineId } from "./composerSend.logic";

const NO_PIPELINES: ReadonlyArray<PipelineDefinition> = [];

// A boolean per environment, so config pushes that leave the capability alone do not re-render
// the composer.
const supportsPipelinesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities.pipelines ===
      true,
  ).pipe(Atom.withLabel(`web-composer-pipelines-supported:${environmentId}`)),
);

function useDraftPipelinesAvailable(environmentId: EnvironmentId, enabled: boolean) {
  const supported = useAtomValue(supportsPipelinesAtom(environmentId));
  const canStart = useAtomValue(serverEnvironment.startPipelineRun.permissionAtom(environmentId));
  return enabled && supported && canStart;
}

/**
 * The pipeline selected on a draft, or null when none is or pipelines are unavailable here.
 * `routeThreadKey` is the draft's scoped thread key.
 */
export function useSelectedDraftPipelineId(
  routeThreadKey: string,
  environmentId: EnvironmentId,
  enabled: boolean,
): PipelineId | null {
  const available = useDraftPipelinesAvailable(environmentId, enabled);
  const selection = useAtomValue(draftPipelineSelectionAtom(routeThreadKey));
  return available ? activeDraftPipelineId(selection, environmentId) : null;
}

/**
 * The pipelines a draft in `environmentId` can start. Subscribes only while `enabled` and the
 * server answers pipelines.* and the connection may start runs.
 */
export function useDraftPipelines(environmentId: EnvironmentId, enabled: boolean) {
  const available = useDraftPipelinesAvailable(environmentId, enabled);
  const query = useEnvironmentQuery(
    available ? serverEnvironment.pipelinesLive({ environmentId, input: {} }) : null,
  );
  return {
    available,
    loaded: query.data !== null,
    pipelines: query.data?.pipelines ?? NO_PIPELINES,
  };
}
