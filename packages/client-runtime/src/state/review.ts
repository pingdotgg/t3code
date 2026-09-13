import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

const diffRefreshes = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:review:refresh:${key}`)),
);

export function invalidateReviewDiffPreviews(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly cwd: string },
) {
  registry.update(
    diffRefreshes(JSON.stringify([target.environmentId, target.cwd])),
    (value) => value + 1,
  );
}

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const diffFileScheduler = createAtomCommandScheduler();
  return {
    applyPatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:apply-patch",
      tag: WS_METHODS.reviewApplyPatch,
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          invalidateReviewDiffPreviews(registry, { environmentId, cwd: input.cwd }),
        ),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.cwd}`,
      },
    }),
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
      refreshTrigger: ({ environmentId, input }) =>
        diffRefreshes(JSON.stringify([environmentId, input.cwd])),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:diff-file-contents",
      tag: WS_METHODS.reviewGetDiffFileContents,
      scheduler: diffFileScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.cwd,
            input.sourceKind,
            input.baseRef,
            input.headRef,
            input.oldPath,
            input.newPath,
            input.changeType,
          ]),
      },
    }),
  };
}
