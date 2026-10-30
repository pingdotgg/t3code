import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { useRef, useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { DesktopBridge, DesktopVoiceTranscript } from "@t3tools/contracts";
import { render, stubGlobal, act } from "../../../test/render";
import { useDesktopVoiceInput } from "../../hooks/useDesktopVoiceInput";
import { ComposerVoiceInput } from "./ComposerVoiceInput";

function setup() {
  let resolve!: (value: DesktopVoiceTranscript) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<DesktopVoiceTranscript>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const transcript = { promise, resolve, reject };
  const recording = new Set<(id: string) => void>();
  const cancelled: string[] = [];
  const stopped: string[] = [];
  let id = "";
  const bridge: NonNullable<DesktopBridge["voiceInput"]> = {
    available: async () => true,
    start: (key) => {
      id = key;
      return transcript.promise;
    },
    stop: async (key) => {
      stopped.push(key);
    },
    cancel: async (key) => {
      cancelled.push(key);
    },
    onRecording: (listener) => {
      recording.add(listener);
      return () => recording.delete(listener);
    },
  };
  return {
    bridge,
    transcript,
    cancelled,
    stopped,
    record: () => act(() => recording.forEach((listener) => listener(id))),
    finish: (text = "native voice") => act(() => transcript.resolve({ text, locale: "en_GB" })),
  };
}

function Composer({ owner = "first" }: { owner?: string }) {
  const [text, setText] = useState("Please replace this.");
  const revision = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const voice = useDesktopVoiceInput({
    ownerKey: owner,
    readDraft: () => ({
      ownerKey: owner,
      text,
      revision: revision.current,
      selection: {
        start: input.current?.selectionStart ?? 0,
        end: input.current?.selectionEnd ?? 0,
      },
    }),
    commitDraft: (next) => setText(next),
  });
  return (
    <div>
      <textarea
        ref={input}
        aria-label="Prompt"
        value={text}
        onChange={(event) => {
          revision.current++;
          setText(event.target.value);
        }}
      />
      <ComposerVoiceInput voice={voice} disabled={false} />
      <div data-testid="send">
        <ComposerPrimaryActions
          compact
          canOperateThread
          pendingAction={null}
          isRunning={false}
          canInterrupt={false}
          showPlanFollowUpPrompt={false}
          promptHasText={Boolean(text)}
          isSendBusy={false}
          sendDisabledReason={voice.busy ? "Finish or discard voice input before sending." : null}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent={Boolean(text)}
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={() => {}}
        />
      </div>
      {voice.error ? <p role="alert">{voice.error}</p> : null}
    </div>
  );
}

it("replaces the captured selection, blocks send, and leaves an editable draft", async () => {
  const native = setup();
  using _bridge = stubGlobal("desktopBridge", { voiceInput: native.bridge });
  await using screen = await render(<Composer />);
  const prompt = screen.getByRole("textbox", { name: "Prompt" });
  (prompt.element() as HTMLTextAreaElement).setSelectionRange(7, 19);
  await screen.getByRole("button", { name: "Start voice input" }).click();
  await expect.element(screen.getByTestId("send").getByRole("button")).toBeDisabled();
  await native.record();
  await screen.getByRole("button", { name: "Finish voice input" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Transcribing…");
  await native.finish();
  await expect.element(prompt).toHaveValue("Please native voice.");
  await expect.element(screen.getByTestId("send").getByRole("button")).toBeEnabled();
  expect(native.stopped).toHaveLength(1);
});

it.each(["Escape", "navigation"])("discards late transcripts after %s", async (action) => {
  const native = setup();
  using _bridge = stubGlobal("desktopBridge", { voiceInput: native.bridge });
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Start voice input" }).click();
  await native.record();
  if (action === "Escape") await userEvent.keyboard("{Escape}");
  else await screen.rerender(<Composer owner="second" />);
  expect(native.cancelled).toHaveLength(1);
  await native.finish();
  await expect.element(screen.getByRole("textbox")).toHaveValue("Please replace this.");
});

it("rejects a transcript when the draft was edited and restored during recording", async () => {
  const native = setup();
  using _bridge = stubGlobal("desktopBridge", { voiceInput: native.bridge });
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Start voice input" }).click();
  await native.record();
  await screen.getByRole("textbox").fill("Changed");
  await screen.getByRole("textbox").fill("Please replace this.");
  await native.finish();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The draft changed. The transcript was not added.");
  await expect.element(screen.getByRole("textbox")).toHaveValue("Please replace this.");
});

it("reports native permission failures and allows retry", async () => {
  const native = setup();
  using _bridge = stubGlobal("desktopBridge", { voiceInput: native.bridge });
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Start voice input" }).click();
  await act(() =>
    native.transcript.reject(new Error("Allow microphone access in System Settings.")),
  );
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Allow microphone access in System Settings.");
  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toBeEnabled();
});
