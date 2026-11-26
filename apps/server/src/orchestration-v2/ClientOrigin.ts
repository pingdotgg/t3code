import type { OrchestrationClientOrigin } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** The authenticated client surface that caused the current command. */
export const CurrentClientOrigin = Context.Reference<OrchestrationClientOrigin | undefined>(
  "t3/orchestration-v2/CurrentClientOrigin",
  { defaultValue: () => undefined },
);
