import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PipelineDefinition } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";

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

/**
 * The pipelines a draft in `environmentId` can start. Subscribes only while `enabled` and the
 * server answers pipelines.* and the connection may start runs.
 */
export function useDraftPipelines(environmentId: EnvironmentId, enabled: boolean) {
  const supported = useAtomValue(supportsPipelinesAtom(environmentId));
  const canStart = useAtomValue(serverEnvironment.startPipelineRun.permissionAtom(environmentId));
  const available = enabled && supported && canStart;
  const query = useEnvironmentQuery(
    available ? serverEnvironment.pipelinesLive({ environmentId, input: {} }) : null,
  );
  return {
    available,
    loaded: query.data !== null,
    pipelines: query.data?.pipelines ?? NO_PIPELINES,
  };
}
