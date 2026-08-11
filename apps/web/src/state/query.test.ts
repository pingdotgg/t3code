import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  result: null as AsyncResult.AsyncResult<unknown, unknown> | null,
  refresh: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: () => harness.refresh,
  useAtomValue: () => harness.result,
}));

import { useEnvironmentQuery } from "./query";

describe("useEnvironmentQuery", () => {
  it("keeps an interrupted request pending instead of exposing an internal error", () => {
    harness.result = AsyncResult.failure(Cause.interrupt(1));

    const query = useEnvironmentQuery(Atom.make(harness.result));

    expect(query.error).toBeNull();
    expect(query.isPending).toBe(true);
  });

  it("continues to expose genuine environment failures", () => {
    harness.result = AsyncResult.failure(Cause.fail(new Error("GitHub did not answer.")));

    const query = useEnvironmentQuery(Atom.make(harness.result));

    expect(query.error).toBe("GitHub did not answer.");
    expect(query.isPending).toBe(false);
  });
});
