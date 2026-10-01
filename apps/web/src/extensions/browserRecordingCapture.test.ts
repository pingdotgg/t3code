import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopPreviewRecordingArtifact } from "@t3tools/contracts";
import { createBrowserCaptureBridge, type BrowserCaptureBridgeDeps } from "./browserCaptureBridge";

const context = {
  client: "desktop",
  resource: {
    namespace: "test.browser",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
};
const session = { tabId: "tab-1", serverEpoch: "epoch-1" };
const runtimeTabId = JSON.stringify(["env-a", "thread-a", "epoch-1", "tab-1"]);
const artifactRef = "recording-recording-1";
const artifact: DesktopPreviewRecordingArtifact = {
  id: "recording-1",
  tabId: runtimeTabId,
  path: "/private/browser-artifacts/recording.webm",
  mimeType: "video/webm",
  sizeBytes: 12,
  createdAt: "2026-09-30T00:00:00.000Z",
};
const grants = [
  "t3.browser/sessions",
  "t3.browser/capture",
  "t3.browser/recording",
  "t3.browser/artifact-actions",
];

function harness(overrides: Partial<BrowserCaptureBridgeDeps> = {}, capabilities = grants) {
  let phase: "idle" | "starting" | "recording" | "stopping" = "idle";
  const listeners = new Set<() => void>();
  const publish = (next: typeof phase) => {
    phase = next;
    for (const listener of listeners) listener();
  };
  const preview = {
    capturePageImage: vi.fn(),
    pickElement: vi.fn(),
    cancelPickElement: vi.fn(),
    revealArtifact: vi.fn(async () => {}),
    copyArtifactToClipboard: vi.fn(async () => {}),
  };
  const recording = {
    start: vi.fn(async () => {
      publish("recording");
      return artifact.createdAt;
    }),
    stop: vi.fn(async () => {
      publish("idle");
      return artifact;
    }),
    find: vi.fn(() => (phase === "idle" ? null : runtimeTabId)),
    phase: vi.fn(() => phase),
    subscribe: vi.fn((callback: () => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
  };
  const writeClipboardText = vi.fn(async () => {});
  const showSavedRecording = vi.fn();
  const lifetime = new AbortController();
  const deps = {
    preview: () => preview,
    resolveThreadScope: () => ({ projectId: "project-a", authoritative: true }),
    serverEpoch: () => "epoch-1",
    presented: () => true,
    recording,
    writeClipboardText,
    platform: () => "MacIntel",
    userActivation: () => true,
    subscribeThread: () => () => {},
    showSavedRecording,
    ...overrides,
  };
  const bind = createBrowserCaptureBridge("env-a", deps);
  const host = bind({
    grants: { capabilities, projectIds: ["project-a"] },
    lifetime: lifetime.signal,
  });
  return {
    host,
    bind,
    recording,
    preview,
    writeClipboardText,
    lifetime,
    publish,
    showSavedRecording,
  };
}

describe("browser recording capture", () => {
  it("saves and reveals a recording over 50 MiB without attempting a transfer", async () => {
    const fixture = harness();
    fixture.recording.stop.mockResolvedValue({ ...artifact, sizeBytes: 51 * 1024 * 1024 });
    await fixture.host.startRecording!({ context, session });
    const result = await fixture.host.stopRecording!({ context, session });
    expect(result).toMatchObject({
      ok: true,
      artifact: { saved: true, sizeBytes: 51 * 1024 * 1024 },
    });
    if (!result.ok || !result.artifact) throw new Error("Expected a saved recording");
    expect(
      await fixture.host.revealArtifact!({ context, artifactRef: result.artifact.artifactRef }),
    ).toEqual({ ok: true });
    expect(fixture.preview.revealArtifact).toHaveBeenCalledWith(artifact.path);
  });

  it("requires live user activation before starting native recording", async () => {
    const fixture = harness({ userActivation: () => false });
    expect(await fixture.host.startRecording!({ context, session })).toMatchObject({
      ok: false,
      failure: { reason: "user-activation-required" },
    });
    expect(fixture.recording.start).not.toHaveBeenCalled();
  });

  it("keeps a transient subscription and republishes when the shell becomes live", () => {
    let authoritative = false;
    let shellChanged = () => {};
    const fixture = harness({
      resolveThreadScope: () => ({ projectId: "project-a", authoritative }),
      subscribeThread: (_threadRef, listener) => {
        shellChanged = listener;
        return () => {};
      },
    });
    fixture.publish("recording");
    const listener = vi.fn();
    fixture.host.subscribeRecording!({ context, session }, listener);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
    authoritative = true;
    shellChanged();
    expect(listener).toHaveBeenLastCalledWith({ ok: true, phase: "recording" });
    fixture.publish("stopping");
    expect(listener).toHaveBeenLastCalledWith({ ok: true, phase: "stopping" });
  });

  it("shows the native saved toast when its installation unloads", async () => {
    const fixture = harness();
    await fixture.host.startRecording!({ context, session });
    fixture.lifetime.abort();
    await fixture.recording.stop.mock.results[0]!.value;
    expect(fixture.showSavedRecording).toHaveBeenCalledWith(artifact);
  });

  it("disposes shell subscriptions once across abort and explicit cleanup", () => {
    const cleanup = vi.fn();
    const fixture = harness({ subscribeThread: () => cleanup });
    const unsubscribe = fixture.host.subscribeRecording!({ context, session }, () => {});
    fixture.lifetime.abort();
    unsubscribe();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not republish unchanged recording state on unrelated shell or recorder updates", () => {
    let authoritative = true;
    let shellChanged = () => {};
    const fixture = harness({
      resolveThreadScope: () => ({ projectId: "project-a", authoritative }),
      subscribeThread: (_threadRef, listener) => {
        shellChanged = listener;
        return () => {};
      },
    });
    const listener = vi.fn();
    const unsubscribe = fixture.host.subscribeRecording!({ context, session }, listener);
    shellChanged();
    fixture.publish("idle");
    expect(listener).toHaveBeenCalledTimes(1);
    fixture.publish("recording");
    shellChanged();
    fixture.publish("recording");
    expect(listener).toHaveBeenCalledTimes(2);
    authoritative = false;
    shellChanged();
    shellChanged();
    expect(listener).toHaveBeenCalledTimes(3);
    authoritative = true;
    shellChanged();
    expect(listener).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenLastCalledWith({ ok: true, phase: "recording" });
    unsubscribe();
  });

  it("both callers joining a native stop receive a saved and revealable recording", async () => {
    const fixture = harness();
    let finishStop!: (saved: DesktopPreviewRecordingArtifact) => void;
    const pending = new Promise<DesktopPreviewRecordingArtifact>((resolve) => {
      finishStop = resolve;
    });
    fixture.recording.stop.mockReturnValue(pending);
    await fixture.host.startRecording!({ context, session });
    const first = fixture.host.stopRecording!({ context, session });
    const second = fixture.host.stopRecording!({ context, session });
    finishStop(artifact);
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ ok: true, artifact: { saved: true } });
      if (!result.ok || !result.artifact) throw new Error("Expected a saved recording");
      expect(
        await fixture.host.revealArtifact!({ context, artifactRef: result.artifact.artifactRef }),
      ).toEqual({ ok: true });
    }
  });

  it("starts the native scoped session, saves locally, and exposes only an artifact ref", async () => {
    const fixture = harness();
    expect(await fixture.host.startRecording!({ context, session })).toEqual({
      ok: true,
      startedAt: artifact.createdAt,
    });
    expect(fixture.recording.start).toHaveBeenCalledWith(
      runtimeTabId,
      { environmentId: "env-a", threadId: "thread-a" },
      "tab-1",
    );
    const result = await fixture.host.stopRecording!({ context, session });
    expect(result).toEqual({
      ok: true,
      artifact: {
        artifactRef,
        mimeType: "video/webm",
        sizeBytes: 12,
        createdAt: artifact.createdAt,
        saved: true,
      },
    });
    expect(fixture.recording.stop).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(artifact.path);
    expect(await fixture.host.revealArtifact!({ context, artifactRef })).toEqual({ ok: true });
    expect(await fixture.host.copyArtifactPath!({ context, artifactRef })).toEqual({ ok: true });
    expect(fixture.preview.revealArtifact).toHaveBeenCalledWith(artifact.path);
    expect(fixture.writeClipboardText).toHaveBeenCalledWith(artifact.path);
    expect(await fixture.host.copyArtifactToClipboard!({ context, artifactRef })).toMatchObject({
      ok: false,
      failure: { reason: "action-failed" },
    });
    expect(fixture.preview.copyArtifactToClipboard).not.toHaveBeenCalled();
  });

  it("denies recording without its own grant before touching native code", async () => {
    const fixture = harness(
      {},
      grants.filter((grant) => grant !== "t3.browser/recording"),
    );
    expect(await fixture.host.startRecording!({ context, session })).toMatchObject({
      ok: false,
      failure: { reason: "grant-denied", grant: "t3.browser/recording" },
    });
    expect(await fixture.host.stopRecording!({ context, session })).toMatchObject({
      ok: false,
      failure: { reason: "grant-denied" },
    });
    expect(fixture.recording.start).not.toHaveBeenCalled();
  });

  it.each([
    ["desktop-required", { preview: () => null }],
    ["not-presented", { presented: () => false }],
    ["epoch-changed", { serverEpoch: () => "epoch-2" }],
    ["scope-invalid", { resolveThreadScope: () => ({ projectId: "other", authoritative: true }) }],
    ["host-unavailable", { resolveThreadScope: () => ({ projectId: null, authoritative: false }) }],
  ] as const)("refuses %s recording starts", async (reason, overrides) => {
    const fixture = harness(overrides);
    expect(await fixture.host.startRecording!({ context, session })).toMatchObject({
      ok: false,
      failure: { reason },
    });
    expect(fixture.recording.start).not.toHaveBeenCalled();
  });

  it("observes native recording phases and unsubscribes on client lifetime end", async () => {
    const fixture = harness();
    const states: unknown[] = [];
    fixture.host.subscribeRecording!({ context, session }, (state) => states.push(state));
    fixture.publish("starting");
    fixture.publish("recording");
    fixture.publish("stopping");
    fixture.publish("idle");
    expect(states).toEqual(
      ["idle", "starting", "recording", "stopping", "idle"].map((phase) => ({ ok: true, phase })),
    );
    fixture.lifetime.abort();
    fixture.publish("recording");
    expect(states).toHaveLength(5);
  });

  it("can stop after the page is hidden or its epoch changes", async () => {
    let shown = true;
    let epoch = "epoch-1";
    const fixture = harness({ presented: () => shown, serverEpoch: () => epoch });
    await fixture.host.startRecording!({ context, session });
    shown = false;
    epoch = "epoch-2";
    expect(await fixture.host.stopRecording!({ context, session })).toMatchObject({ ok: true });
    expect(fixture.recording.stop).toHaveBeenCalledWith(runtimeTabId);
  });

  it("reports idle stops and cancels starts before native dispatch", async () => {
    const fixture = harness();
    expect(await fixture.host.stopRecording!({ context, session })).toEqual({
      ok: true,
      artifact: null,
    });
    expect(
      await fixture.host.startRecording!({ context, session, signal: AbortSignal.abort() }),
    ).toMatchObject({ ok: false, failure: { reason: "cancelled" } });
    expect(fixture.recording.start).not.toHaveBeenCalled();
  });

  it("stops the native recording when its installation is unloaded", async () => {
    const fixture = harness();
    await fixture.host.startRecording!({ context, session });
    fixture.lifetime.abort();
    expect(fixture.recording.stop).toHaveBeenCalledWith(runtimeTabId);
  });

  it("does not let another installation act on a saved recording", async () => {
    const fixture = harness();
    await fixture.host.startRecording!({ context, session });
    await fixture.host.stopRecording!({ context, session });
    const other = fixture.bind({
      grants: { capabilities: grants, projectIds: ["project-a"] },
      lifetime: new AbortController().signal,
    });
    expect(await other.revealArtifact!({ context, artifactRef })).toMatchObject({
      ok: false,
      failure: { reason: "artifact-not-found" },
    });
  });

  it("sanitizes native failures rather than exposing local paths", async () => {
    const fixture = harness();
    fixture.recording.start.mockRejectedValue(new Error(artifact.path));
    const result = await fixture.host.startRecording!({ context, session });
    expect(result).toMatchObject({ ok: false, failure: { reason: "recording-failed" } });
    expect(JSON.stringify(result)).not.toContain(artifact.path);
  });

  it("does not stop a new native recording after its own one already ended", async () => {
    const fixture = harness();
    await fixture.host.startRecording!({ context, session });
    fixture.publish("idle");
    fixture.publish("recording");
    fixture.lifetime.abort();
    expect(fixture.recording.stop).not.toHaveBeenCalled();
  });

  it("keeps local recording saves independent of the artifact-actions grant", async () => {
    const fixture = harness(
      {},
      grants.filter((grant) => grant !== "t3.browser/artifact-actions"),
    );
    await fixture.host.startRecording!({ context, session });
    expect(await fixture.host.stopRecording!({ context, session })).toMatchObject({ ok: true });
    expect(await fixture.host.revealArtifact!({ context, artifactRef })).toMatchObject({
      ok: false,
      failure: { reason: "grant-denied", grant: "t3.browser/artifact-actions" },
    });
    expect(fixture.preview.revealArtifact).not.toHaveBeenCalled();
  });

  it("rejects unauthorized state subscriptions without observing native recordings", () => {
    const fixture = harness({}, ["t3.browser/sessions", "t3.browser/capture"]);
    const listener = vi.fn();
    fixture.host.subscribeRecording!({ context, session }, listener);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        failure: expect.objectContaining({ reason: "grant-denied", grant: "t3.browser/recording" }),
      }),
    );
    expect(fixture.recording.subscribe).not.toHaveBeenCalled();
  });

  it("retains ownership of a new recording while an earlier local save completes", async () => {
    const fixture = harness();
    let completeSave!: (value: DesktopPreviewRecordingArtifact) => void;
    fixture.recording.stop.mockImplementationOnce(() => {
      return new Promise<DesktopPreviewRecordingArtifact>((resolve) => {
        completeSave = resolve;
      });
    });
    await fixture.host.startRecording!({ context, session });
    const stopped = fixture.host.stopRecording!({ context, session });
    fixture.publish("idle");
    await fixture.host.startRecording!({ context, session });
    completeSave(artifact);
    await stopped;
    fixture.publish("recording");
    fixture.lifetime.abort();
    expect(fixture.recording.stop).toHaveBeenCalledWith(runtimeTabId);
  });
});
