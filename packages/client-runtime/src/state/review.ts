import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    diffPreview: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewSubscribeDiffPreview,
      idleTtlMs: 0,
    }),
  };
}
