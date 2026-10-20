import { useEffect } from "react";
import { render } from "../../test/render";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useActiveThreadRef } from "./useActiveThreadRef";

type ThreadLike = { environmentId: EnvironmentId; id: ThreadId; status: string } | null;

async function renderThread(value: ThreadLike) {
  let observed: ScopedThreadRef | null = null;
  function Probe({ thread }: { thread: ThreadLike }) {
    const result = useActiveThreadRef(thread);
    useEffect(() => {
      observed = result;
    });
    return null;
  }
  const screen = await render(<Probe thread={value} />);
  return {
    ...screen,
    get current() {
      return observed;
    },
    async update(value: ThreadLike) {
      await screen.rerender(<Probe thread={value} />);
      return observed;
    },
  };
}

const thread = (id: string, status = "idle"): ThreadLike => ({
  environmentId: "env-1" as EnvironmentId,
  id: id as ThreadId,
  status,
});

describe("useActiveThreadRef", () => {
  it("keeps the same ref while the thread object is replaced during a run", async () => {
    await using screen = await renderThread(thread("t1", "running"));
    const first = screen.current;
    const afterUpdate = await screen.update(thread("t1", "waiting"));

    expect(first).toEqual({ environmentId: "env-1", threadId: "t1" });
    expect(afterUpdate).toBe(first);
  });

  it("returns a new ref when the thread changes or goes away", async () => {
    await using screen = await renderThread(thread("t1"));
    const first = screen.current;
    const switched = await screen.update(thread("t2"));
    const gone = await screen.update(null);

    expect(switched).not.toBe(first);
    expect(switched).toEqual({ environmentId: "env-1", threadId: "t2" });
    expect(gone).toBeNull();
  });
});
