import type { OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
};
