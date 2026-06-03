import type { NamespaceNode } from "../Namespace.ts";

/**
 * Persisted state for an {@link Action}. Actions share the same FQN
 * namespace as resources but are discriminated by `kind: "action"`. The
 * engine keys action state in the {@link State} store under the same `fqn`
 * field as resources.
 */
export type ActionState = RunningActionState | RanActionState;

export type ActionStatus = ActionState["status"];

interface BaseActionState {
  readonly kind: "action";
  /** Type of the Action (e.g. "NightlySync"). Mirrors `resourceType` for resources. */
  actionType: string;
  /** Namespace of the Action. */
  namespace: NamespaceNode | undefined;
  /** Fully qualified name (namespace + logical id). */
  fqn: string;
  /** Logical id of the Action (stable across runs). */
  logicalId: string;
  /** Current status. */
  status: ActionStatus;
  /** FQNs of nodes that depend on this Action's output. */
  downstream: string[];
  /** Hash of the resolved input, used to skip noop runs. */
  inputHash: string;
  /** Resolved input snapshot from the most recent attempt. */
  input: unknown;
}

/**
 * The Action body has started but persistence after success has not yet
 * occurred. On resume the engine treats this as "should run" since the
 * effect may have completed but the output wasn't durably recorded.
 */
export interface RunningActionState extends BaseActionState {
  status: "running";
}

/**
 * The Action body completed and its output is durably persisted. Future
 * plans skip the body when `inputHash` matches the new resolved input
 * (unless `--force` is set).
 */
export interface RanActionState extends BaseActionState {
  status: "ran";
  /** Materialized output value returned by the Action body. */
  output: unknown;
}
