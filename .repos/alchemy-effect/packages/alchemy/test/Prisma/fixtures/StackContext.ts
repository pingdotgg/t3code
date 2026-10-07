import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import * as Layer from "effect/Layer";

/**
 * Placeholder `Stack` + `Stage` for suites that build a provider layer and
 * drive its lifecycle operations directly instead of deploying a stack.
 */
export const testStackContext = Layer.mergeAll(
  Layer.succeed(Stage, "test"),
  Layer.succeed(Stack, {
    name: "test",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
);
