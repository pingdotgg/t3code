import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { createEnvironmentThreadStateAtoms, type ThreadSnapshotLoader } from "./threads.ts";

describe("createEnvironmentThreadStateAtoms", () => {
  it("retains thread state across short subscriber gaps", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const atom = threads.stateAtom(environmentId, threadId);

    expect(atom.idleTTL).toBe(THREAD_STATE_IDLE_TTL_MS);
    expect(threads.stateAtom(environmentId, threadId)).toBe(atom);
    expect(threads.stateAtom(environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
  });
});
