import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerSpeechButton, ComposerSpeechRecordingPill } from "./ComposerSpeechButton";

const inPhase = (phase: VoiceInputState["phase"]): VoiceInputState => ({
  phase,
  error: null,
  errorAction: null,
});

function SpeechControls() {
  const [state, setState] = useState(inPhase("idle"));
  return (
    <>
      <textarea aria-label="Draft" />
      <div>
        <ComposerSpeechRecordingPill
          state={state}
          progress={null}
          level={0}
          onStart={() => setState(inPhase("preparing"))}
          onStop={() => setState(inPhase("transcribing"))}
          onCancel={() => setState(inPhase("idle"))}
          onSkipPostProcessing={() => setState(inPhase("idle"))}
        />
        <ComposerSpeechButton state={state} onStart={() => setState(inPhase("preparing"))} />
      </div>
    </>
  );
}

it("keeps keyboard focus on the dictation controls as they swap", async () => {
  await using screen = await render(<SpeechControls />);
  await userEvent.click(screen.getByRole("textbox", { name: "Draft" }));
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("button", { name: "Cancel voice input" })).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toHaveFocus();
});
