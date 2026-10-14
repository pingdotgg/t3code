import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { holdFramesForCapture, releaseCaptureFrames } from "./agentFrameRequests";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

const shell = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => shell.atom },
}));
type Shell = { readonly runtime: { readonly status: string } | null };
const shellAtom = Atom.make<Shell | null>(null).pipe(Atom.keepAlive);
shell.atom = shellAtom;
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const drawing = (tabId: string) => useBrowserSurfaceStore.getState().activityByTabId[tabId] ?? 0;

afterEach(() => {
  releaseCaptureFrames("tab-1");
  vi.useRealTimers();
});

describe("capture frame leases", () => {
  it("keeps an active turn drawing until it ends, including after the capture limit", () => {
    vi.useFakeTimers();
    appAtomRegistry.set(shellAtom, { runtime: { status: "running" } });
    holdFramesForCapture("tab-1", threadRef);
    holdFramesForCapture("tab-1", threadRef);
    vi.advanceTimersByTime(10_000);
    expect(drawing("tab-1")).toBe(1);
    appAtomRegistry.set(shellAtom, { runtime: { status: "idle" } });
    expect(drawing("tab-1")).toBe(0);
  });

  it("bounds the lease when the background thread shell is missing", () => {
    vi.useFakeTimers();
    appAtomRegistry.set(shellAtom, null);
    holdFramesForCapture("tab-1", threadRef);
    expect(drawing("tab-1")).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(drawing("tab-1")).toBe(0);
  });

  it("draws without thread state and stops after the capture limit", () => {
    vi.useFakeTimers();
    holdFramesForCapture("tab-1");
    expect(drawing("tab-1")).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(drawing("tab-1")).toBe(0);
  });

  it("renews one lease for repeated captures", () => {
    vi.useFakeTimers();
    holdFramesForCapture("tab-1");
    vi.advanceTimersByTime(4_000);
    holdFramesForCapture("tab-1");
    expect(drawing("tab-1")).toBe(1);
    vi.advanceTimersByTime(4_000);
    expect(drawing("tab-1")).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(drawing("tab-1")).toBe(0);
  });

  it("releases a removed guest without releasing another activity lease", () => {
    vi.useFakeTimers();
    const releaseRecording = useBrowserSurfaceStore.getState().acquireActivity("tab-1");
    holdFramesForCapture("tab-1");
    expect(drawing("tab-1")).toBe(2);
    releaseCaptureFrames("tab-1");
    releaseCaptureFrames("tab-1");
    vi.advanceTimersByTime(5_000);
    expect(drawing("tab-1")).toBe(1);
    releaseRecording();
    expect(drawing("tab-1")).toBe(0);
  });
});
