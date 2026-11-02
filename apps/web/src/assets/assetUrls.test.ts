import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeRevisionedAssetUrlFamily } from "./assetUrls";

const environmentId = EnvironmentId.make("environment-1");
const resource: AssetResource = {
  _tag: "workspace-file",
  threadId: ThreadId.make("thread-1"),
  path: "docs/diagram.png",
};

type MintResult = AsyncResult.AsyncResult<{ relativeUrl: string; expiresAt: number }>;

const minted = (n: number): MintResult =>
  AsyncResult.success({ relativeUrl: `/a/${n}`, expiresAt: 0 });

// A stand-in for the asset URL query: a refresh starts a mint (counted, shown as
// waiting) and `settle` completes the latest one.
function setup(initial: MintResult) {
  let mints = 0;
  // Node removal runs on the registry's scheduler; `unmount` flushes it so the
  // next mount of the same revision builds a fresh node.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const server = Atom.make(initial).pipe(Atom.keepAlive);
  const query = Atom.readable(
    (get) => get(server),
    () => {
      mints += 1;
      registry.set(server, AsyncResult.waiting(registry.get(server)));
    },
  ).pipe(Atom.keepAlive);
  const revisioned = makeRevisionedAssetUrlFamily(() => query);
  const mount = (revision: string | null) => {
    const release = registry.mount(revisioned({ environmentId, input: { resource }, revision }));
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  const settle = () => registry.set(server, minted(mints + 1));
  return { mount, settle, mints: () => mints };
}

describe("makeRevisionedAssetUrlFamily", () => {
  it("re-mints a settled URL on first read and on each new revision, not on remount", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-1")();
    expect(mints()).toBe(1);
    settle();

    mount("mutation-1")();
    expect(mints()).toBe(1);

    mount("mutation-2")();
    expect(mints()).toBe(2);
  });

  it("re-mints when a revert returns to an earlier revision", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-a")();
    settle();
    mount("mutation-b")();
    settle();
    expect(mints()).toBe(2);

    const reverted = mount("mutation-a");
    expect(mints()).toBe(3);
    reverted();
  });

  it("shares a mint in flight on the first read", () => {
    const { mount, mints } = setup(AsyncResult.initial(true));

    mount("mutation-1")();
    expect(mints()).toBe(0);
  });

  it("re-mints after a mint that was in flight when the revision changed", () => {
    const { mount, settle, mints } = setup(minted(0));

    const before = mount("mutation-1");
    settle();
    const edited = mount("mutation-2");
    expect(mints()).toBe(2);
    before();

    const stillMinting = mount("mutation-3");
    edited();
    expect(mints()).toBe(2);

    settle();
    expect(mints()).toBe(3);
    settle();
    expect(mints()).toBe(3);
    stillMinting();
  });
});
