import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ActionState } from "./ActionState.ts";
import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";

/**
 * Anything persistable under an FQN. Resources are discriminated by status
 * strings ("creating", "created", …) and Tasks by `kind: "action"`.
 */
export type PersistedState = ResourceState | ActionState;

export const isActionState = (
  s: PersistedState | undefined,
): s is ActionState => !!s && (s as any).kind === "action";

export const isResourceState = (
  s: PersistedState | undefined,
): s is ResourceState => !!s && (s as any).kind !== "task";

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  message: string;
  cause?: Error;
}> {}

export class State extends Context.Service<
  State,
  Effect.Effect<StateService>
>()("alchemy/State") {}

/**
 * State service interface.
 *
 * Resources are keyed by FQN (namespace-qualified key) which includes
 * the full namespace path plus the logical ID. The FQN is used as the
 * storage key while logicalId remains available in the persisted state
 * for provider operations.
 */
export interface StateService {
  /**
   * Stable identifier for the State store implementation, used for
   * telemetry tagging (`alchemy.state_store.id`) so we can answer
   * "which backends are people using" without hard-coding a closed
   * union. Examples: `"local"`, `"inmemory"`, `"http"`,
   * `"cloudflare-http"`. Third-party state stores should pick a short,
   * stable, kebab-case slug.
   */
  readonly id: string;
  /**
   * Wire / behavioural contract version of this state-store
   * implementation. For local / in-process stores this is the
   * `STATE_STORE_VERSION` the CLI was built against; for HTTP-backed
   * stores it is the version reported by the deployed `/version`
   * probe.
   */
  getVersion(): Effect.Effect<number, StateStoreError, never>;
  listStacks(): Effect.Effect<readonly string[], StateStoreError, never>;
  listStages(
    stack: string,
  ): Effect.Effect<readonly string[], StateStoreError, never>;
  /**
   * Get a resource by its FQN (namespace-qualified key).
   */
  get(request: {
    stack: string;
    stage: string;
    fqn: string;
  }): Effect.Effect<PersistedState | undefined, StateStoreError, never>;
  /**
   * List top-level resources that are still in replacement cleanup.
   *
   * Any additional backlog from repeated replacements is stored recursively
   * in the returned state's `old` chain.
   */
  getReplacedResources(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<
    ReadonlyArray<ReplacedResourceState>,
    StateStoreError,
    never
  >;
  /**
   * Set a resource by its FQN (namespace-qualified key).
   */
  set<V extends PersistedState>(request: {
    stack: string;
    stage: string;
    fqn: string;
    value: V;
  }): Effect.Effect<V, StateStoreError, never>;
  /**
   * Delete a resource by its FQN (namespace-qualified key).
   */
  delete(request: {
    stack: string;
    stage: string;
    fqn: string;
  }): Effect.Effect<void, StateStoreError, never>;
  /**
   * Delete an entire stack, or a single stage when `stage` is provided.
   */
  deleteStack(request: {
    stack: string;
    stage?: string;
  }): Effect.Effect<void, StateStoreError, never>;
  /**
   * List all resource FQNs in a stack/stage.
   */
  list(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<readonly string[], StateStoreError, never>;
  /**
   * Read the persisted stack output for `(stack, stage)`. Returns
   * `undefined` when the stack has not been deployed (or has been
   * destroyed) at this stage.
   *
   * Stack outputs are written by `apply` once the deploy succeeds and
   * read by cross-stack references (`yield* OtherStack` /
   * `OtherStack.stage.<name>` / `Output.stackRef(...)`).
   */
  getOutput(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<unknown, StateStoreError, never>;
  /**
   * Persist the resolved stack output for `(stack, stage)`.
   */
  setOutput(request: {
    stack: string;
    stage: string;
    value: unknown;
  }): Effect.Effect<unknown, StateStoreError, never>;
}
