import type { VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { chatGitStatusAtom } from "./vcs";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsActionManager: () => ({}),
  createVcsEnvironmentAtoms: () => ({}),
  createVcsStatusRevalidationAtomFamily: () => () => null,
}));

const status = (changes: Partial<VcsStatusResult> = {}) =>
  AsyncResult.success({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 1, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...changes,
  } satisfies VcsStatusResult);

describe("chatGitStatusAtom", () => {
  it("notifies only when a field the chat view reads changes", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<AsyncResult.AsyncResult<VcsStatusResult, never>>(status());
    const selected = chatGitStatusAtom(source as never);
    const notified: unknown[] = [];
    const unsubscribe = registry.subscribe(selected, (value) => notified.push(value));
    registry.get(selected);
    notified.length = 0;

    registry.set(
      source,
      status({ workingTree: { files: [], insertions: 2, deletions: 0 }, aheadCount: 1 }),
    );
    expect(notified).toEqual([]);

    registry.set(source, status({ refName: "feature" }));
    expect(notified).toHaveLength(1);
    unsubscribe();
  });
});
