import {
  WS_METHODS,
  type EnvironmentId,
  type SourceControlCloneProgress,
  type SourceControlCloneRepositoryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import { runStream } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeStreamCommand,
  runStreamInEnvironment,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const cloneRepositoryWithProgress = createRuntimeStreamCommand(runtime, {
    label: "environment-data:source-control:clone-repository-with-progress",
    scheduler: commandScheduler,
    concurrency: {
      mode: "serial",
      key: (target: { readonly environmentId: EnvironmentId }) => target.environmentId,
    },
    execute: (
      target: {
        readonly environmentId: EnvironmentId;
        readonly input: SourceControlCloneRepositoryInput;
        readonly onProgress?: (progress: SourceControlCloneProgress) => void;
      },
      _registry,
    ) =>
      runStreamInEnvironment(
        target.environmentId,
        runStream(WS_METHODS.sourceControlCloneRepositoryWithProgress, target.input),
      ).pipe(
        Stream.tap((event) =>
          event.type !== "progress" || target.onProgress === undefined
            ? Effect.void
            : Effect.sync(() => {
                try {
                  target.onProgress?.(event);
                } catch {
                  // Presentation callbacks must not fail the clone operation.
                }
              }),
        ),
        Stream.filterMap((event) =>
          event.type === "complete" ? Result.succeed(event.result) : Result.failVoid,
        ),
      ),
  });

  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    cloneRepositoryWithProgress,
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
