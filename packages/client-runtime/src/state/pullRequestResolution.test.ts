import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestActivity,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { createOptimisticPullRequestResolution } from "./pullRequestResolution.ts";
import type { AtomCommandResult } from "./runtime.ts";

const target = {
  environmentId: EnvironmentId.make("host"),
  input: { projectId: ProjectId.make("project"), repository: "org/repo", number: 1 },
};
const thread = (id: string, isResolved = false): PullRequestReviewThread => ({
  id,
  isResolved,
  path: `${id}.ts`,
  line: 3,
  side: "right",
  isOutdated: false,
  comments: [
    {
      id: `comment:${id}`,
      body: `Review ${id}`,
      author: null,
      createdAt: "2026-10-14T00:00:00Z",
      url: null,
    },
  ],
});
const initial: PullRequestActivity = {
  comments: [],
  commits: [],
  commentCount: 2,
  commentsTruncated: false,
  reviewThreads: [thread("first"), thread("second")],
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});
function harness() {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const source = Atom.make<AsyncResult.AsyncResult<PullRequestActivity, Error>>(
    AsyncResult.success(initial),
  );
  const optimistic = createOptimisticPullRequestResolution(() => source);
  const view = optimistic.activity(target);
  registry.mount(view);
  const value = () => {
    const result = registry.get(view);
    if (result._tag !== "Success") throw new Error("Expected the existing activity");
    return result.value;
  };
  return { registry, source, optimistic, value };
}
function gate() {
  let release!: (value: AtomCommandResult<void, Error>) => void;
  const result = new Promise<AtomCommandResult<void, Error>>((resolve) => {
    release = resolve;
  });
  return { result, release };
}
const success = () => AsyncResult.success<void, Error>(undefined);
const failure = () =>
  AsyncResult.failure<void, Error>(Cause.fail(new Error("Host rejected resolution")));
const input = (threadId: string, resolved: boolean) => ({
  ...target,
  input: { ...target.input, threadId, resolved },
});

describe("optimistic review thread resolution", () => {
  it("updates all activity readers synchronously, then rolls back only the failed resolution", async () => {
    const { registry, optimistic, value } = harness();
    const save = gate();
    const command = optimistic.wrap({ label: "resolve", run: () => save.result });
    const first = command.run(registry, input("first", true));
    expect(value().reviewThreads.map((thread) => [thread.id, thread.isResolved])).toEqual([
      ["first", true],
      ["second", false],
    ]);
    const anotherView = registry.get(
      optimistic.activity({ ...target, input: { ...target.input } }),
    );
    expect(anotherView._tag === "Success" && anotherView.value.reviewThreads[0]?.isResolved).toBe(
      true,
    );
    expect(value().reviewThreads[0]?.comments).toBe(initial.reviewThreads[0]?.comments);
    save.release(failure());
    await first;
    expect(value().reviewThreads).toEqual(initial.reviewThreads);
  });

  it("keeps accepted resolution through stale and waiting reads until the host catches up", async () => {
    const { registry, source, optimistic, value } = harness();
    await optimistic
      .wrap({ label: "resolve", run: async () => success() })
      .run(registry, input("first", true));
    registry.set(source, AsyncResult.success(initial, { waiting: true }));
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    registry.set(source, AsyncResult.success(initial));
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    const confirmed = { ...initial, reviewThreads: [thread("first", true), thread("second")] };
    registry.set(source, AsyncResult.success(confirmed));
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    // The projection retires after confirmation: later external changes remain visible.
    registry.set(source, AsyncResult.success(initial));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
  });

  it("does not let an older failure restore its state over a newer reversal", async () => {
    const { registry, source, optimistic, value } = harness();
    const saves = [gate(), gate()];
    let call = 0;
    const command = optimistic.wrap({ label: "resolve", run: () => saves[call++]!.result });
    const first = command.run(registry, input("first", true));
    const second = command.run(registry, input("first", false));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    saves[0]!.release(failure());
    await first;
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    // A stale response from the earlier resolve still cannot override the newer unresolve.
    registry.set(
      source,
      AsyncResult.success({ ...initial, reviewThreads: [thread("first", true), thread("second")] }),
    );
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    saves[1]!.release(success());
    await second;
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    registry.set(source, AsyncResult.success(initial));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
  });

  it("retires a confirmed reversal and its accepted predecessor without needing an intermediate host read", async () => {
    const { registry, source, optimistic, value } = harness();
    registry.set(source, AsyncResult.success(initial, { waiting: true }));
    const command = optimistic.wrap({ label: "resolve", run: async () => success() });
    await command.run(registry, input("first", true));
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    await command.run(registry, input("first", false));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    registry.set(source, AsyncResult.success(initial));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    // Both accepted intents are retired, so the next independent host resolution is visible.
    registry.set(
      source,
      AsyncResult.success({ ...initial, reviewThreads: [thread("first", true), thread("second")] }),
    );
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
  });

  it("keeps an accepted predecessor available for rollback while its reversal is pending", async () => {
    const { registry, source, optimistic, value } = harness();
    registry.set(source, AsyncResult.success(initial, { waiting: true }));
    await optimistic
      .wrap({ label: "resolve", run: async () => success() })
      .run(registry, input("first", true));
    const save = gate();
    const reversal = optimistic
      .wrap({ label: "unresolve", run: () => save.result })
      .run(registry, input("first", false));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    registry.set(source, AsyncResult.success(initial));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    save.release(failure());
    await reversal;
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    registry.set(
      source,
      AsyncResult.success({ ...initial, reviewThreads: [thread("first", true), thread("second")] }),
    );
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    registry.set(source, AsyncResult.success(initial));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
  });

  it("allows separate threads to resolve immediately while another mutation is pending", async () => {
    const { registry, optimistic, value } = harness();
    const saves = [gate(), gate()];
    let call = 0;
    const command = optimistic.wrap({ label: "resolve", run: () => saves[call++]!.result });
    const first = command.run(registry, input("first", true));
    const second = command.run(registry, input("second", true));
    expect(value().reviewThreads.map((thread) => thread.isResolved)).toEqual([true, true]);
    saves[0]!.release(failure());
    await first;
    expect(value().reviewThreads.map((thread) => thread.isResolved)).toEqual([false, true]);
    saves[1]!.release(success());
    await second;
    expect(value().reviewThreads.map((thread) => thread.isResolved)).toEqual([false, true]);
  });

  it("isolates pending state by environment and PR even when their thread IDs overlap", async () => {
    const { registry, optimistic, value } = harness();
    const save = gate();
    const mutation = optimistic
      .wrap({ label: "resolve", run: () => save.result })
      .run(registry, input("first", true));
    for (const other of [
      { ...target, environmentId: EnvironmentId.make("other") },
      { ...target, input: { ...target.input, number: 2 } },
      { ...target, input: { ...target.input, host: "enterprise.example" } },
    ]) {
      const result = registry.get(optimistic.activity(other));
      expect(result._tag === "Success" && result.value.reviewThreads[0]?.isResolved).toBe(false);
    }
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    save.release(failure());
    await mutation;
  });

  it("reopens a resolved thread immediately and restores it if unresolve is refused", async () => {
    const { registry, source, optimistic, value } = harness();
    registry.set(
      source,
      AsyncResult.success({ ...initial, reviewThreads: [thread("first", true), thread("second")] }),
    );
    const save = gate();
    const mutation = optimistic
      .wrap({ label: "unresolve", run: () => save.result })
      .run(registry, input("first", false));
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
    save.release(failure());
    await mutation;
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
  });

  it("forwards explicit refreshes to the source activity", () => {
    const registry = AtomRegistry.make();
    registries.push(registry);
    let refreshes = 0;
    const source = Atom.readable(
      () => AsyncResult.success(initial),
      () => {
        refreshes++;
      },
    );
    const optimistic = createOptimisticPullRequestResolution(() => source);
    const view = optimistic.activity(target);
    registry.mount(view);
    registry.refresh(view);
    expect(refreshes).toBe(1);
  });

  it("rolls back if command execution throws before acceptance", async () => {
    const { registry, optimistic, value } = harness();
    const command = optimistic.wrap({
      label: "resolve",
      run: async () => {
        throw new Error("Transport failed");
      },
    });
    const result = command.run(registry, input("first", true));
    expect(value().reviewThreads[0]?.isResolved).toBe(true);
    await expect(result).rejects.toThrow("Transport failed");
    expect(value().reviewThreads[0]?.isResolved).toBe(false);
  });
});
