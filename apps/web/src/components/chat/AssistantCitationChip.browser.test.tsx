import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
import { act, render } from "../../../test/render";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";

const mocks = vi.hoisted(() => ({
  observeSource: vi.fn(),
  dispose: vi.fn(),
  transcribeCalls: 0,
  transcript: null as Promise<string> | null,
}));
const environment = vi.hoisted(() => ({
  environmentId: "environment",
  serverConfig: {
    environment: { capabilities: { voiceTranscription: true, cloudVoiceTranscription: false } },
  },
}));
const preparedConnection = vi.hoisted(() => ({
  environmentId: "environment",
  label: "environment",
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  usePreparedConnection: ((environmentId: string | null) =>
    environmentId === preparedConnection.environmentId
      ? Option.some(preparedConnection)
      : Option.none()) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: ((environmentId: string | null) =>
    environmentId === environment.environmentId ? environment : null) as never,
}));
vi.mock(import("../../speech/runEnvironmentSpeech"), () => ({
  runEnvironmentSpeech: Effect.runPromise as never,
}));
vi.mock(import("@t3tools/client-runtime/voice-input"), async (importOriginal) => ({
  ...(await importOriginal()),
  getEnvironmentSpeechStatus: (() =>
    Effect.succeed({
      supported: true,
      state: "ready",
      modelId: "test-model",
      model: "Test",
      size: 1,
      supportsStreaming: false,
      supportsTranslation: false,
      acceleration: "auto",
      benchmarkTier: "accelerated",
      modelUnloadTimeout: "min_15",
      gpuDevices: [],
    })) as never,
}));
vi.mock(import("../../speech/browserVoiceInput"), () => ({
  createAppleSpeechVoiceInputPlatform: vi.fn() as never,
  createBrowserVoiceInputPlatform: (() => ({
    recorder: {
      uri: "blob:recording",
      prepareToRecordAsync: async () => {},
      record() {},
      stop: async () => {},
    },
    transcriber: {
      prepare: async () => ({
        locale: "en",
        transcribe: async () => {
          mocks.transcribeCalls += 1;
          return mocks.transcript ?? "dictated comment";
        },
      }),
    },
    cancelRecording() {},
    deleteRecording() {},
  })) as never,
}));
vi.mock(import("./AssistantCitationSource"), async (importOriginal) => ({
  ...(await importOriginal()),
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

// The mocked source observer is shared, so every test starts by resetting it.
function setup() {
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
  const source = document.createElement("p");
  source.textContent = "hello";
  document.body.append(source);
  const range = document.createRange();
  range.selectNodeContents(source);
  const sourceAnchor = { source, range, viewport: document.body } as AssistantCitationSourceAnchor;
  return { sourceAnchor, [Symbol.dispose]: () => source.remove() };
}

function useDictation() {
  chooseAudioDestination({ kind: "environment", environmentId: citation.environmentId });
  chooseTranscriptCleanup(false);
  mocks.transcribeCalls = 0;
  mocks.transcript = null;
}

function mount(
  sourceAnchor: AssistantCitationSourceAnchor | undefined,
  onSave: () => boolean,
  chipCitation: AssistantCitation = citation,
) {
  function Composer() {
    const [open, setOpen] = useState(true);
    return (
      <AssistantCitationChip
        citation={chipCitation}
        commentEditor={{ open, sourceAnchor, onOpenChange: setOpen, onSave }}
      />
    );
  }
  return render(
    <>
      <Composer />
      <button type="button">Outside</button>
    </>,
  );
}

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

async function typeComment(value: string) {
  const input = textarea()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  await act(async () => onUnavailable());
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    await typeComment(draft);
    await removeSource();

    expect(textarea()?.value).toBe(draft);
    expect(textarea()?.getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    await typeComment("shortened comment");
    await clickButton("Save");
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(textarea()).toBeNull();
  });

  it("keeps a draft open and unsaved when the cited row unmounts mid-typing", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await typeComment("if it's a good bug rep");
    await removeSource();

    expect(onSave).not.toHaveBeenCalled();
    expect(textarea()?.value).toBe("if it's a good bug rep");

    await typeComment("if it's a good bug report");
    await clickButton("Save");
    expect(onSave).toHaveBeenCalledExactlyOnceWith("if it's a good bug report");
  });

  it("preserves a rejected save and allows a later retry", async () => {
    using source = setup();
    const onSave = vi.fn(() => false);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await typeComment("keep this draft");
    await removeSource();
    await clickButton("Save");

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(textarea()?.value).toBe("keep this draft");
    onSave.mockReturnValue(true);
    await clickButton("Save");
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(textarea()).toBeNull();
  });
});

describe("citation comment caret", () => {
  it("opens a saved comment with the caret after its end, scrolled into view", async () => {
    using _source = setup();
    const comment = `${"line\n".repeat(40)}end`;
    await using _screen = await mount(
      undefined,
      vi.fn(() => true),
      { ...citation, comment },
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));
    const input = textarea()!;

    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(input.scrollTop).toBe(input.scrollHeight - input.clientHeight);
    await userEvent.keyboard("!");
    expect(input.value).toBe(`${comment}!`);
  });

  it("saves with Tab then Enter after typing a comment", async () => {
    using _source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(undefined, onSave);
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));

    await userEvent.keyboard("agreed");
    // The redesign keeps a mic before the buttons even without dictation; Cancel stays skipped.
    await userEvent.keyboard("{Tab}{Tab}");
    await userEvent.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("agreed");
  });
});

describe("citation comment popup position", () => {
  it("opens at its anchor instead of sliding in from the window corner", async () => {
    using source = setup();
    await using _screen = await mount(
      source.sourceAnchor,
      vi.fn(() => true),
    );
    const positioner = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
    await vi.waitFor(() => expect(positioner()?.style.opacity).not.toBe("0"));

    const moves = positioner()!
      .getAnimations()
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          ["transform", "top", "left"].includes(animation.transitionProperty),
      );
    expect(moves).toEqual([]);
  });

  it("stays on screen when the cited text ends in a code block's hidden overflow", async () => {
    using _source = setup();
    const message = document.createElement("div");
    message.className = "chat-markdown";
    message.style.width = "240px";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    // Highlighted code is split into token spans, so the range's last client rect
    // covers only the final token, wholly inside the hidden overflow.
    for (let index = 0; index < 40; index += 1) {
      const token = document.createElement("span");
      token.textContent = `token${index} `;
      code.append(token);
    }
    pre.append(code);
    message.append(pre);
    document.body.prepend(message);
    using _message = { [Symbol.dispose]: () => message.remove() };
    const range = document.createRange();
    range.selectNodeContents(code);
    const rects = range.getClientRects();
    expect(rects.item(rects.length - 1)!.left).toBeGreaterThan(window.innerWidth);
    const sourceAnchor = {
      source: message,
      range,
      viewport: document.body,
    } as AssistantCitationSourceAnchor;

    await using _screen = await mount(
      sourceAnchor,
      vi.fn(() => true),
    );
    const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
    await vi.waitFor(() => expect(popup()?.getBoundingClientRect().width).toBeGreaterThan(0));
    // Typing scrolls ancestors to reveal the caret, which shifts the whole app
    // sideways when the box is off screen.
    await userEvent.keyboard("note");

    expect(textarea()?.value).toBe("note");
    expect(document.scrollingElement?.scrollLeft).toBe(0);
    expect(document.body.scrollLeft).toBe(0);
    const rect = popup()!.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  });
});

describe("citation comment dictation", () => {
  async function startDictation(onSave: () => boolean) {
    using _source = setup();
    useDictation();
    const screen = await mount(undefined, onSave);
    await page.getByRole("button", { name: "Start voice input" }).click();
    await expect.element(page.getByRole("button", { name: "Finish voice input" })).toBeVisible();
    return screen;
  }

  it("keeps the dictation when the box is clicked away while recording", async () => {
    const onSave = vi.fn(() => true);
    await using _screen = await startDictation(onSave);

    await page.getByRole("button", { name: "Outside" }).click();

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("dictated comment"));
  });

  it("keeps the dictation when the box is clicked away while transcribing", async () => {
    const onSave = vi.fn(() => true);
    await using _screen = await startDictation(onSave);
    let finish!: (text: string) => void;
    mocks.transcript = new Promise((resolve) => (finish = resolve));
    await page.getByRole("button", { name: "Finish voice input" }).click();
    await vi.waitFor(() => expect(mocks.transcribeCalls).toBe(1));

    await page.getByRole("button", { name: "Outside" }).click();
    finish("dictated comment");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("dictated comment"));
  });
});
