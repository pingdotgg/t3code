import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useActiveThreadRef } from "./useActiveThreadRef";

type ThreadLike = { environmentId: EnvironmentId; id: ThreadId; status: string } | null;

let renderer: ReactTestRenderer | null = null;
let observed: Array<ScopedThreadRef | null> = [];

function Probe({ thread }: { thread: ThreadLike }) {
  observed.push(useActiveThreadRef(thread));
  return null;
}

const thread = (id: string, status = "idle"): ThreadLike => ({
  environmentId: "env-1" as EnvironmentId,
  id: id as ThreadId,
  status,
});

async function render(value: ThreadLike) {
  await act(() => {
    if (renderer) renderer.update(<Probe thread={value} />);
    else renderer = create(<Probe thread={value} />);
  });
  return observed.at(-1);
}

beforeEach(() => {
  observed = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("useActiveThreadRef", () => {
  it("keeps the same ref while the thread object is replaced during a run", async () => {
    const first = await render(thread("t1", "running"));
    const afterUpdate = await render(thread("t1", "waiting"));

    expect(first).toEqual({ environmentId: "env-1", threadId: "t1" });
    expect(afterUpdate).toBe(first);
  });

  it("returns a new ref when the thread changes or goes away", async () => {
    const first = await render(thread("t1"));
    const switched = await render(thread("t2"));
    const gone = await render(null);

    expect(switched).not.toBe(first);
    expect(switched).toEqual({ environmentId: "env-1", threadId: "t2" });
    expect(gone).toBeNull();
  });
});
