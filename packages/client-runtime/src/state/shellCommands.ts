import { type CritOpenInput, type CritOpenError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createShellEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    openInEditor: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:open-in-editor",
      tag: WS_METHODS.shellOpenInEditor,
    }),
    openInCrit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:open-in-crit",
      tag: WS_METHODS.shellOpenInCrit,
      execute: ({
        forward,
        ...input
      }: CritOpenInput & {
        readonly forward?: (port: number) => Effect.Effect<void, CritOpenError, Scope.Scope>;
      }) =>
        forward === undefined
          ? requestGuarded(WS_METHODS.shellOpenInCrit, input)
          : runStreamGuarded(WS_METHODS.shellForwardCritReview, input).pipe(
              Stream.runForEach(forward),
              Effect.scoped,
              Effect.as(null),
            ),
    }),
  };
}
