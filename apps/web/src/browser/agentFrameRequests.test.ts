import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { holdFramesForTurn } from "./agentFrameRequests";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

const shell = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => shell.atom },
}));

type Shell = { readonly runtime: { readonly status: string } | null };
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const shellAtom = Atom.make<Shell | null>(null).pipe(Atom.keepAlive);
shell.atom = shellAtom;
const setStatus = (status: string) => appAtomRegistry.set(shellAtom, { runtime: { status } });
const drawing = (tabId: string) => useBrowserSurfaceStore.getState().activityByTabId[tabId] ?? 0;

describe("holdFramesForTurn", () => {
  beforeEach(() => setStatus("idle"));

  it("keeps a hidden tab drawing until the thread's turn ends", () => {
    setStatus("running");
    holdFramesForTurn("tab-1", threadRef);
    // Later captures in the same turn reuse the lease.
    holdFramesForTurn("tab-1", threadRef);
    expect(drawing("tab-1")).toBe(1);
    setStatus("idle");
    expect(drawing("tab-1")).toBe(0);
  });

  it("does not draw for a capture outside a turn", () => {
    holdFramesForTurn("tab-2", threadRef);
    expect(drawing("tab-2")).toBe(0);
  });
});
