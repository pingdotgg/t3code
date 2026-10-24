import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { holdFramesForCapture } from "./captureFrames";

vi.mock("~/state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const shell = Atom.make<{ runtime: { status: string } } | null>(null).pipe(Atom.keepAlive);
  return { environmentThreadShells: { threadShellAtom: () => shell } };
});

type TestShell = { runtime: { status: string } } | null;
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const shellAtom = environmentThreadShells.threadShellAtom(
  threadRef,
) as unknown as Atom.Writable<TestShell>;
const activity = () => useBrowserSurfaceStore.getState().activityByTabId["tab-1"];

describe("holdFramesForCapture", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ activityByTabId: {} });
  });
  afterEach(() => {
    appAtomRegistry.set(shellAtom, null);
    vi.useRealTimers();
  });

  it("keeps a captured tab drawing until its thread's turn ends", () => {
    appAtomRegistry.set(shellAtom, { runtime: { status: "running" } });

    holdFramesForCapture("tab-1", threadRef);
    holdFramesForCapture("tab-1", threadRef);
    expect(activity()).toBe(1);

    appAtomRegistry.set(shellAtom, { runtime: { status: "idle" } });
    expect(activity()).toBeUndefined();
  });

  it("draws for one capture when the thread is not running a turn", () => {
    vi.useFakeTimers();

    holdFramesForCapture("tab-1", threadRef);
    vi.advanceTimersByTime(9_999);
    expect(activity()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(activity()).toBeUndefined();
  });
});
