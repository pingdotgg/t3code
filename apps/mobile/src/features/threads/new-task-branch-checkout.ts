import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

export type BranchCheckoutResult = AtomCommandResult<VcsRef, unknown>;
type BranchCheckoutFailure = Extract<BranchCheckoutResult, { readonly _tag: "Failure" }>;

export interface BranchCheckoutRequest {
  /** The draft route's flow key; the checkout is abandoned once it leaves the stack. */
  readonly flowKey: string;
  readonly routeKey: string;
  readonly environmentId: EnvironmentId | null;
  readonly workspaceRoot: string | null;
  readonly branch: string;
  readonly worktreePath: string | null;
}

// The family key lists the request's fields in a fixed order, so equal
// requests share one key and start can rebuild the request from it.
const RequestKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.String,
    Schema.String,
    Schema.NullOr(EnvironmentId),
    Schema.NullOr(Schema.String),
    Schema.String,
    Schema.NullOr(Schema.String),
  ]),
);
const encodeRequestKey = Schema.encodeSync(RequestKey);
const decodeRequestKey = Schema.decodeSync(RequestKey);

/** A pure, stable key for a request: the same fields always give the same key. */
export function branchCheckoutRequestKey(request: BranchCheckoutRequest): string {
  return encodeRequestKey([
    request.flowKey,
    request.routeKey,
    request.environmentId,
    request.workspaceRoot,
    request.branch,
    request.worktreePath,
  ]);
}

function requestFromKey(key: string): BranchCheckoutRequest {
  const [flowKey, routeKey, environmentId, workspaceRoot, branch, worktreePath] =
    decodeRequestKey(key);
  return { flowKey, routeKey, environmentId, workspaceRoot, branch, worktreePath };
}

interface CheckoutEntry {
  readonly request: BranchCheckoutRequest;
  readonly checkout: Promise<BranchCheckoutResult>;
  readonly release: () => void;
  abandoned: boolean;
}

/**
 * Branch checkouts for draft routes. A checkout is a Git mutation, so it is
 * tied to the request, not to an atom node: the node can be removed and rebuilt
 * (a render read before the subscription commits) without running it again.
 */
export function makeNewTaskBranchCheckouts(deps: {
  readonly run: (request: BranchCheckoutRequest) => Promise<BranchCheckoutResult>;
  /** Holds navigation until the checkout settles and its route is released. */
  readonly holdNavigation: (operation: Promise<unknown>) => void;
  /** Runs once the route is released, unless the route was abandoned first. */
  readonly onFailure: (request: BranchCheckoutRequest, result: BranchCheckoutFailure) => void;
}) {
  // Ignoring a stale result cannot undo its Git mutation, so checkouts run one
  // at a time across routes.
  let tail: Promise<unknown> = Promise.resolve();
  // Registered when a checkout starts, never from render.
  const entries = new Map<string, CheckoutEntry>();

  function abandon(key: string, entry: CheckoutEntry): void {
    entry.abandoned = true;
    entry.release();
    entries.delete(key);
  }

  function start(key: string): Promise<BranchCheckoutResult> {
    const existing = entries.get(key);
    if (existing) return existing.checkout;
    const request = requestFromKey(key);
    // A route asks for one checkout at a time; a superseded request no longer
    // owns the route's failure handling or holds navigation.
    for (const [otherKey, other] of entries) {
      if (other.request.flowKey === request.flowKey) abandon(otherKey, other);
    }
    const released = Promise.withResolvers<void>();
    const checkout = tail.then(() => deps.run(request));
    tail = checkout.catch(() => undefined);
    const entry: CheckoutEntry = { request, checkout, release: released.resolve, abandoned: false };
    entries.set(key, entry);
    const handled = checkout.then(async (result) => {
      if (result._tag === "Success") return;
      await released.promise;
      if (!entry.abandoned) deps.onFailure(request, result);
    });
    // Navigation waits for the failure handling too, so its goBack lands first.
    deps.holdNavigation(Promise.allSettled([handled, released.promise]));
    return checkout;
  }

  return {
    atom: Atom.family((key: string) =>
      Atom.make(Effect.promise(() => start(key))).pipe(
        Atom.withLabel("mobile:new-task-branch-checkout"),
      ),
    ),
    /** The route rendered with removal unblocked, so navigation may proceed. */
    release(key: string): void {
      entries.get(key)?.release();
    },
    /** Abandons the checkouts of draft routes that are no longer on the stack. */
    prune(liveFlowKeys: ReadonlySet<string>): void {
      for (const [key, entry] of entries) {
        if (!liveFlowKeys.has(entry.request.flowKey)) abandon(key, entry);
      }
    },
  };
}
