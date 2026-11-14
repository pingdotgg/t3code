import { EnvironmentId, type AssetResource } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeLongLivedAssetUrlFamily } from "./longLivedAssetUrls";

const environmentId = EnvironmentId.make("environment-1");
const resource: AssetResource = {
  _tag: "attachment",
  attachmentId: "attachment-1",
  fileName: "page.html",
  mimeType: "text/html",
  disposition: "inline",
};

type MintResult = AsyncResult.AsyncResult<{ relativeUrl: string; expiresAt: number }>;

const url = (relativeUrl: string, expiresAt: number): MintResult =>
  AsyncResult.success({ relativeUrl, expiresAt });

function setup(initial: MintResult) {
  let mints = 0;
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
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
  const family = makeLongLivedAssetUrlFamily(() => query, { minLifeMs: 100, now: () => 1_000 });
  const atom = family({ environmentId, input: { resource } });
  let unmount = registry.mount(atom);
  // Readers adopt any Success, waiting or not, as `assetUrlStateFromResult` does.
  const relativeUrl = () => {
    const value = registry.get(atom);
    return value._tag === "Success" ? value.value.relativeUrl : null;
  };
  return {
    relativeUrl,
    mints: () => mints,
    serve: (result: MintResult) => registry.set(server, result),
    remount: () => {
      unmount();
      // Runs the idle-TTL disposal, so the next mount builds a fresh node.
      for (const task of tasks.splice(0)) task();
      unmount = registry.mount(atom);
    },
  };
}

describe("makeLongLivedAssetUrlFamily", () => {
  it("reuses a cached URL with enough life left", () => {
    const { relativeUrl, mints } = setup(url("/cached", 2_000));
    expect(relativeUrl()).toBe("/cached");
    expect(mints()).toBe(0);
  });

  it("mints a URL near expiry and hides it until the new one arrives", () => {
    const { relativeUrl, mints, serve } = setup(url("/stale", 1_050));
    expect(mints()).toBe(1);
    expect(relativeUrl()).toBeNull();

    serve(url("/fresh", 5_000));
    expect(relativeUrl()).toBe("/fresh");
  });

  it("does not hand a new reader the expiring URL while an earlier reader's mint is in flight", () => {
    const { relativeUrl, mints, serve, remount } = setup(url("/stale", 1_050));
    expect(mints()).toBe(1);
    remount();
    expect(relativeUrl()).toBeNull();

    serve(url("/fresh", 5_000));
    expect(relativeUrl()).toBe("/fresh");
    expect(mints()).toBe(1);
  });

  it("mints at most once when the clock disagrees with the server", () => {
    const { relativeUrl, mints, serve } = setup(url("/stale", 1_050));
    serve(url("/still-short", 1_050));
    expect(relativeUrl()).toBe("/still-short");
    expect(mints()).toBe(1);
  });

  it("waits for a URL still loading", () => {
    const { relativeUrl, mints, serve } = setup(AsyncResult.initial(true));
    expect(relativeUrl()).toBeNull();
    serve(url("/loaded", 5_000));
    expect(relativeUrl()).toBe("/loaded");
    expect(mints()).toBe(0);
  });
});
