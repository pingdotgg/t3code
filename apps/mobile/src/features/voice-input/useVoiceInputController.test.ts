import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";

const mocks = vi.hoisted(() => ({
  preferences: {} as { voiceInputSendImmediately?: boolean },
  transcribe: vi.fn(async () => "recognized text"),
  recorder: {
    uri: "file:///recording.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
    getStatus: () => ({ isRecording: false }),
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(mocks.preferences),
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  useAudioRecorder: () => mocks.recorder,
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => {},
  setIsAudioActiveAsync: async () => {},
}));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: () => {},
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]) };
});
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return { useSharedValue: (value: unknown) => useRef({ value }).current };
});
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => ({
    prepare: async () => ({ locale: "en-US", transcribe: mocks.transcribe }),
  }),
}));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));

import { useVoiceInputController } from "./useVoiceInputController";

let renderer: ReactTestRenderer;
let voice: ReturnType<typeof useVoiceInputController>;
let currentText: string;
const sent: string[] = [];
function Composer({ owner = "thread", blocked = false }: { owner?: string; blocked?: boolean }) {
  const [text, setText] = useState("Existing draft");
  const controller = useVoiceInputController({
    ownerKey: owner,
    draftMessage: text,
    selection: { start: text.length, end: text.length },
    onChangeDraftMessage: setText,
    onChangeSelection: () => {},
    onSubmit: () => {
      if (!blocked && !controller.blocksSubmission) sent.push(text);
    },
  });
  useEffect(() => {
    currentText = text;
    voice = controller;
  });
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.preferences = {};
  mocks.transcribe.mockReset().mockResolvedValue("recognized text");
  sent.length = 0;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

async function record() {
  await act(async () => {
    voice.start();
  });
  await act(async () => {
    await voice.stop();
  });
}

describe("voice input submission", () => {
  it("inserts into the composer by default", async () => {
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await record();
    expect(currentText).toBe("Existing draft recognized text");
    expect(sent).toEqual([]);
  });
  it("sends the committed full draft exactly once after unlocking submission", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await record();
    await act(async () => {
      renderer.update(createElement(Composer));
    });
    expect(sent).toEqual(["Existing draft recognized text"]);
  });
  it("leaves a blocked send in the composer without sending later", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await act(async () => {
      renderer = create(createElement(Composer, { blocked: true }));
    });
    await record();
    await act(async () => {
      renderer.update(createElement(Composer));
    });
    expect(currentText).toBe("Existing draft recognized text");
    expect(sent).toEqual([]);
  });
  it.each(["", "   "])("does not send an empty transcript (%j)", async (transcript) => {
    mocks.preferences = { voiceInputSendImmediately: true };
    mocks.transcribe.mockResolvedValue(transcript);
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await record();
    expect(currentText).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
  it("does not send after cancellation during transcription", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    const result = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    mocks.transcribe.mockImplementation(() => {
      entered.resolve();
      return result.promise;
    });
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await act(async () => {
      voice.start();
    });
    let stopping: Promise<void>;
    await act(async () => {
      stopping = voice.stop();
      await entered.promise;
    });
    await act(async () => {
      voice.cancel();
      result.resolve("late text");
      await stopping;
    });
    expect(currentText).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
  it("does not send a failed transcription", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    mocks.transcribe.mockRejectedValue(new Error("unavailable"));
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await record();
    expect(currentText).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
  it("keeps the setting captured when recording starts", async () => {
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await act(async () => {
      voice.start();
    });
    mocks.preferences = { voiceInputSendImmediately: true };
    await act(async () => {
      renderer.update(createElement(Composer));
    });
    await act(async () => {
      await voice.stop();
    });
    expect(currentText).toBe("Existing draft recognized text");
    expect(sent).toEqual([]);
  });
  it("discards a transcript when the composer owner changes", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    const result = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    mocks.transcribe.mockImplementation(() => {
      entered.resolve();
      return result.promise;
    });
    await act(async () => {
      renderer = create(createElement(Composer));
    });
    await act(async () => {
      voice.start();
    });
    let stopping: Promise<void>;
    await act(async () => {
      stopping = voice.stop();
      await entered.promise;
    });
    await act(async () => {
      renderer.update(createElement(Composer, { owner: "other-thread" }));
    });
    await act(async () => {
      result.resolve("late text");
      await stopping;
    });
    expect(currentText).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
});
