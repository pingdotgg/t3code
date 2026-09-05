import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";
import { VoiceInputSession } from "./voiceInputSession";

beforeEach(resetVoiceInputGlobalsForTests);

function harness() {
  const drafts = new Map([
    ["environment:a", "Hello"],
    ["environment:b", "Other draft"],
  ]);
  const recorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: vi.fn(async () => undefined),
    record: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const releaseRecording = vi.fn(async () => undefined);
  const deleteRecording = vi.fn();
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => ({
      prepare: async () => ({ locale: "en-US", transcribe: async () => "there" }),
    }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording,
    deleteRecording,
    readText: (key) => drafts.get(key) ?? "",
    writeText: (key, text) => {
      drafts.set(key, text);
      session.draftChanged();
    },
  });
  return { session, drafts, recorder, releaseRecording, deleteRecording };
}
const selection = { start: 5, end: 5 };

describe("VoiceInputSession", () => {
  it("keeps the original recording when its screen leaves and another draft tries to record", async () => {
    const { session, recorder, drafts } = harness();
    const unsubscribe = session.subscribe(vi.fn());
    await session.start("environment:a", selection);
    unsubscribe();
    expect(await session.start("environment:b", { start: 0, end: 0 })).toBe(false);
    await session.controller.appMovedToBackground();
    expect(session.getSnapshot().state.phase).toBe("recording");
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(await session.start("environment:a", selection)).toBe(true);
    expect(recorder.record).toHaveBeenCalledOnce();
    await session.controller.stop();
    expect(drafts.get("environment:a")).toBe("Hello there");
    expect(drafts.get("environment:b")).toBe("Other draft");
  });

  it("commits native duration-limit completion to the original draft with no screen mounted", async () => {
    const { session, drafts, deleteRecording, releaseRecording } = harness();
    await session.start("environment:a", selection);
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    expect(drafts.get("environment:a")).toBe("Hello there");
    expect(session.getSnapshot()).toMatchObject({
      ownerKey: "environment:a",
      state: { phase: "idle" },
      selection: { start: 11, end: 11 },
    });
    expect(deleteRecording).toHaveBeenCalledWith("file:///voice.m4a");
    expect(releaseRecording).toHaveBeenCalledOnce();
    await session.start("environment:b", { start: 0, end: 0 });
    expect(session.getSnapshot()).toMatchObject({
      ownerKey: "environment:b",
      state: { phase: "recording" },
    });
    await session.controller.interruptRecording();
  });

  it("delivers the completed cursor only once and only to the original draft", async () => {
    const { session } = harness();
    await session.start("environment:a", selection);
    await session.controller.stop();
    expect(session.takeSelection("environment:b")).toBeNull();
    expect(session.takeSelection("environment:a")).toEqual({ start: 11, end: 11 });
    expect(session.takeSelection("environment:a")).toBeNull();
    expect(session.getSnapshot().selection).toBeNull();
  });

  it("drops a pending cursor if the draft is edited before its composer returns", async () => {
    const { session, drafts } = harness();
    await session.start("environment:a", selection);
    await session.controller.stop();
    drafts.set("environment:a", "Edited after dictation");
    session.draftChanged();
    expect(session.takeSelection("environment:a")).toBeNull();
  });

  it("rejects a transcript if the original draft was edited and then restored while away", async () => {
    const { session, drafts } = harness();
    await session.start("environment:a", selection);
    drafts.set("environment:a", "Changed");
    session.draftChanged();
    drafts.set("environment:a", "Hello");
    session.draftChanged();
    await session.controller.stop();
    expect(drafts.get("environment:a")).toBe("Hello");
    expect(session.getSnapshot().state.error).toContain("draft changed");
  });

  it("releases the recording after a native interruption so another draft can record", async () => {
    const { session, drafts } = harness();
    await session.start("environment:a", selection);
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: true,
      error: "Audio interrupted",
      url: "file:///voice.m4a",
    });
    expect(drafts.get("environment:a")).toBe("Hello");
    await session.start("environment:b", { start: 0, end: 0 });
    expect(session.getSnapshot().state.phase).toBe("recording");
    await session.controller.interruptRecording();
  });
});
