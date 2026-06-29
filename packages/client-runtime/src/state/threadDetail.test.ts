import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { EnvironmentThreadState } from "./threads.ts";

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-detail"),
  threadId: ThreadId.make(v2Projection.thread.id),
};

describe("createEnvironmentThreadDetailAtoms", () => {
  it("adds environment scope while preserving the pristine projection", () => {
    const initial: AsyncResult.AsyncResult<EnvironmentThreadState, never> = AsyncResult.success({
      data: Option.some(v2Projection),
      status: "cached",
      error: Option.none(),
    });
    const sourceAtom = Atom.make(initial);
    const details = createEnvironmentThreadDetailAtoms(() => sourceAtom);
    const registry = AtomRegistry.make();

    const thread = registry.get(details.threadAtom(ref));
    expect(thread).toEqual({ environmentId: ref.environmentId, projection: v2Projection });
    expect(thread?.projection).toBe(v2Projection);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("cached");

    registry.set(
      sourceAtom,
      AsyncResult.success({
        data: Option.some(v2Projection),
        status: "synchronizing",
        error: Option.none(),
      }),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.statusAtom(ref))).toBe("synchronizing");

    registry.set(
      sourceAtom,
      AsyncResult.success({
        data: Option.some(v2Projection),
        status: "live",
        error: Option.some("Stream interrupted."),
      }),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("live");
    expect(registry.get(details.errorAtom(ref))).toBe("Stream interrupted.");

    registry.set(
      sourceAtom,
      AsyncResult.success({
        data: Option.none(),
        status: "deleted",
        error: Option.none(),
      }),
    );

    expect(registry.get(details.threadAtom(ref))).toBeNull();
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toEqual([]);
    expect(registry.get(details.statusAtom(ref))).toBe("deleted");
    expect(registry.get(details.errorAtom(ref))).toBeNull();
    registry.dispose();
  });
});
