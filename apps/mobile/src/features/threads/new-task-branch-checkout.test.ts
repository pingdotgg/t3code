import { AsyncResult, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  type BranchCheckoutRequest,
  type BranchCheckoutResult,
  branchCheckoutRequestKey,
  makeNewTaskBranchCheckouts,
} from "./new-task-branch-checkout";

function request(flowKey: string, branch: string): BranchCheckoutRequest {
  return {
    flowKey,
    routeKey: flowKey,
    environmentId: null,
    workspaceRoot: "/repo",
    branch,
    worktreePath: null,
  };
}

function setup() {
  const runs: Array<{
    readonly request: BranchCheckoutRequest;
    readonly settle: (result: BranchCheckoutResult) => void;
  }> = [];
  const holds: Array<Promise<unknown>> = [];
  const onFailure = vi.fn();
  const checkouts = makeNewTaskBranchCheckouts({
    run: (input) =>
      new Promise((resolve) => {
        runs.push({ request: input, settle: resolve });
      }),
    holdNavigation: (operation) => holds.push(operation),
    onFailure,
  });
  return { checkouts, runs, holds, onFailure };
}

const success = (name: string): BranchCheckoutResult =>
  AsyncResult.success({ name, current: true, isDefault: false, worktreePath: null });
const failure: BranchCheckoutResult = AsyncResult.failure(Cause.fail(new Error("dirty tree")));

describe("new task branch checkouts", () => {
  it("runs once per request even when its atom node is removed and rebuilt", async () => {
    const { checkouts, runs } = setup();
    const key = branchCheckoutRequestKey(request("flow-a", "feature"));

    // A render read with no subscriber, then the node is dropped before the
    // subscription commits, then the subscription builds a fresh node.
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => undefined;
      },
    });
    const flushRemovals = () => tasks.splice(0).forEach((task) => task());

    registry.get(checkouts.atom(key));
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    flushRemovals();
    expect(registry.getNodes().size).toBe(0);
    const unmount = registry.mount(checkouts.atom(key));
    runs[0]!.settle(success("feature"));
    await vi.waitFor(() =>
      expect(AsyncResult.isSuccess(registry.get(checkouts.atom(key)))).toBe(true),
    );
    unmount();

    expect(runs).toHaveLength(1);
  });

  it("serializes checkouts across routes", async () => {
    const { checkouts, runs } = setup();
    const unmountA = appAtomRegistry.mount(
      checkouts.atom(branchCheckoutRequestKey(request("flow-a", "a"))),
    );
    const unmountB = appAtomRegistry.mount(
      checkouts.atom(branchCheckoutRequestKey(request("flow-b", "b"))),
    );
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]!.request.branch).toBe("a");

    runs[0]!.settle(success("a"));
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]!.request.branch).toBe("b");
    runs[1]!.settle(success("b"));
    unmountA();
    unmountB();
  });

  it("handles a failure only after the route is released, and never once it left", async () => {
    const { checkouts, runs, holds, onFailure } = setup();
    const keyA = branchCheckoutRequestKey(request("flow-a", "a"));
    const keyB = branchCheckoutRequestKey(request("flow-b", "b"));
    const unmountA = appAtomRegistry.mount(checkouts.atom(keyA));
    const unmountB = appAtomRegistry.mount(checkouts.atom(keyB));

    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.settle(failure);
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(onFailure).not.toHaveBeenCalled();
    checkouts.release(keyA);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onFailure.mock.calls[0]![0]).toMatchObject({ flowKey: "flow-a" });

    checkouts.prune(new Set(["flow-a"]));
    runs[1]!.settle(failure);
    checkouts.release(keyB);
    // The hold settles only after the failure continuation has run.
    await holds[1];
    expect(onFailure).toHaveBeenCalledTimes(1);
    unmountA();
    unmountB();
  });

  it("stops holding navigation when its route leaves the stack", async () => {
    const { checkouts, runs, holds } = setup();
    const unmount = appAtomRegistry.mount(
      checkouts.atom(branchCheckoutRequestKey(request("flow-a", "a"))),
    );
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.settle(success("a"));

    checkouts.prune(new Set());
    await expect(holds[0]).resolves.toBeDefined();
    unmount();
  });
});
