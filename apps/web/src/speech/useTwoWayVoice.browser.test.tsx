import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useTwoWayVoice } from "./useTwoWayVoice";
import { voiceSpeakingAtom } from "./voiceReplies";

const TWO_WAY_PAUSE_MS = 1_500;

type Input = Parameters<typeof useTwoWayVoice>[0];

function Probe(props: Input) {
  useTwoWayVoice(props);
  return null;
}

/** Fake speech input and callbacks for one test; disposing ends any reply read aloud. */
function voice() {
  const start = vi.fn(async () => true);
  const cancel = vi.fn();
  const submitAfterDictation = vi.fn<(submit: (text: string) => void) => void>();
  const onSpoken = vi.fn();
  const onStopped = vi.fn();
  const ui = (
    phase: VoiceInputPhase,
    options: { active?: boolean; heard?: string; error?: string } = {},
  ) => (
    <AppAtomRegistryProvider>
      <Probe
        active={options.active ?? true}
        disabled={false}
        speech={{
          available: true,
          state: { phase, error: options.error ?? null, errorAction: null },
          preview: options.heard === undefined ? null : { committed: options.heard, tentative: "" },
          start,
          cancel,
          submitAfterDictation,
        }}
        onSpoken={onSpoken}
        onStopped={onStopped}
      />
    </AppAtomRegistryProvider>
  );
  return {
    start,
    cancel,
    submitAfterDictation,
    onSpoken,
    onStopped,
    ui,
    speaking: (on: boolean) => act(() => appAtomRegistry.set(voiceSpeakingAtom, on)),
    [Symbol.dispose]: () => appAtomRegistry.set(voiceSpeakingAtom, false),
  };
}

it("stays off the microphone while voice is not two-way", async () => {
  using fake = voice();
  await using _screen = await render(fake.ui("idle", { active: false }));
  expect(fake.start).not.toHaveBeenCalled();
});

it("listens, and sends what was said once the speaker pauses", async () => {
  using fake = voice();
  await using screen = await render(fake.ui("idle"));
  expect(fake.start).toHaveBeenCalledOnce();
  using _timers = fakeTimers();
  await screen.rerender(fake.ui("recording", { heard: "hello" }));
  vi.advanceTimersByTime(TWO_WAY_PAUSE_MS - 1);
  await screen.rerender(fake.ui("recording", { heard: "hello there" }));
  vi.advanceTimersByTime(TWO_WAY_PAUSE_MS - 1);
  expect(fake.submitAfterDictation).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(fake.submitAfterDictation).toHaveBeenCalledOnce();
  fake.submitAfterDictation.mock.calls[0]![0](" hello there ");
  expect(fake.onSpoken).toHaveBeenCalledWith("hello there");
  await screen.rerender(fake.ui("idle"));
  expect(fake.start).toHaveBeenCalledTimes(2);
});

it("stops listening while a reply is read aloud", async () => {
  using fake = voice();
  await using screen = await render(fake.ui("idle"));
  await screen.rerender(fake.ui("recording"));
  await fake.speaking(true);
  expect(fake.cancel).toHaveBeenCalledOnce();
  await screen.rerender(fake.ui("idle"));
  expect(fake.start).toHaveBeenCalledOnce();
  await fake.speaking(false);
  expect(fake.start).toHaveBeenCalledTimes(2);
});

it("stops when voice input needs setting up first", async () => {
  using fake = voice();
  fake.start.mockResolvedValue(false);
  await using _screen = await render(fake.ui("idle"));
  await vi.waitFor(() =>
    expect(fake.onStopped).toHaveBeenCalledWith(
      "Finish setting up voice input, then turn two-way voice on again.",
    ),
  );
});

it("listens again after silence but reports any other failure", async () => {
  using fake = voice();
  await using screen = await render(fake.ui("idle"));
  await screen.rerender(fake.ui("error", { error: "No speech was detected." }));
  expect(fake.start).toHaveBeenCalledTimes(2);
  await screen.rerender(fake.ui("error", { error: "Microphone access was denied." }));
  expect(fake.onStopped).toHaveBeenCalledWith("Microphone access was denied.");
  await screen.rerender(fake.ui("idle", { active: false }));
  expect(fake.cancel).not.toHaveBeenCalled();
});
