import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  session: null as import("./voiceInputSession").VoiceInputSession | null,
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback]),
}));
vi.mock("./VoiceInputProvider", () => ({
  useGlobalVoiceInput: () => {
    const session = harness.session!;
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return { ...snapshot, isAvailable: true, isBusy: false, session };
  },
}));

import { useVoiceInputController } from "./useVoiceInputController";
import { VoiceInputSession } from "./voiceInputSession";

function Composer(props: { readonly hidden: boolean }) {
  useVoiceInputController({
    ownerKey: "thread-1",
    label: "Thread",
    readDraftMessage: () => "",
    selection: { start: 0, end: 0 },
    hidden: props.hidden,
    onChangeDraftMessage: () => {},
    onChangeSelection: () => {},
  });
  return null;
}

function setup() {
  const session = new VoiceInputSession({
    recorder: {
      uri: "file:///voice.m4a",
      prepareToRecordAsync: async () => {},
      record: () => {},
      stop: async () => {},
    },
    getTranscriber: () => ({
      prepare: async () => ({ locale: "en-US", transcribe: async () => "" }),
    }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: () => {},
    sampleRecording: () => null,
    publishAudioLevels: () => {},
    keepAwake: () => () => {},
  });
  harness.session = session;
  const root = createRoot(document.createElement("div"));
  return {
    isFocused: () => session.getSnapshot().focusedOwners.has("thread-1"),
    render: (hidden: boolean) => act(() => root.render(<Composer hidden={hidden} />)),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      session.dispose();
    },
  };
}

// GlobalVoiceInputControl hides its dictation pill while the recording owner is focused, so a
// composer that stays mounted under display: none (e.g. behind an agent question) must unfocus.
it("unfocuses a hidden composer so the global dictation controls can show", () => {
  using voice = setup();

  voice.render(false);
  expect(voice.isFocused()).toBe(true);

  voice.render(true);
  expect(voice.isFocused()).toBe(false);

  voice.render(false);
  expect(voice.isFocused()).toBe(true);
});
