import type {
  OrchestrationThread,
  OrchestrationThreadHistoryOutline,
  OrchestrationThreadHistoryPage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export type EnvironmentThreadHistoryState =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "ready";
      readonly outline: OrchestrationThreadHistoryOutline | null;
      readonly window: OrchestrationThreadHistoryPage | null;
      readonly loading: "before" | "after" | "around" | null;
    };

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly liveData: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  readonly history: EnvironmentThreadHistoryState;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  liveData: Option.none(),
  status: "empty",
  error: Option.none(),
  history: { kind: "disabled" },
};
