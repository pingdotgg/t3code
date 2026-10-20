import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { detectComposerTrigger } from "../../composer-logic";
import { useComposerTriggerState } from "./useComposerTriggerState";

const command = "pnpm install -g @openai/codex@latest";
const initialPrompt = "pnpm install -g @openai";
let composer: ReturnType<typeof useComposerTriggerState>;

function ComposerProbe() {
  const state = useComposerTriggerState(() =>
    detectComposerTrigger(initialPrompt, initialPrompt.length),
  );
  useLayoutEffect(() => {
    composer = state;
  });
  return null;
}

async function updatePrompt(text: string, cursor = text.length) {
  await act(() => composer.setTrigger(detectComposerTrigger(text, cursor)));
}

const renderComposer = () =>
  render(
    <StrictMode>
      <ComposerProbe />
    </StrictMode>,
  );

describe("composer suggestion dismissal", () => {
  it("closes suggestions and rejects keyboard selection before the next render", async () => {
    await using _screen = await renderComposer();
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    expect(composer.trigger).toEqual(candidate);

    await act(() => {
      composer.dismissTrigger(candidate);
      expect(composer.resolveTrigger(candidate)).toBeNull();
    });
    expect(composer.trigger).toBeNull();
  });

  it("stays dismissed while typing a scoped package, including its second @", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));

    for (let cursor = initialPrompt.length; cursor <= command.length; cursor += 1) {
      const text = command.slice(0, cursor);
      await updatePrompt(text);
      expect(composer.trigger).toBeNull();
      expect(composer.resolveTrigger(detectComposerTrigger(text, cursor))).toBeNull();
    }
  });

  it("stays dismissed while deleting characters or moving within the same word", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));

    for (let cursor = initialPrompt.length - 1; cursor > initialPrompt.indexOf("@"); cursor -= 1) {
      await updatePrompt(initialPrompt, cursor);
      expect(composer.trigger).toBeNull();
      await updatePrompt(initialPrompt.slice(0, cursor));
      expect(composer.trigger).toBeNull();
    }
  });

  it("opens suggestions for a new @ word after a space", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${command} `);
    await updatePrompt(`${command} @src`);

    expect(composer.trigger?.query).toBe("src");
    expect(composer.trigger?.rangeStart).toBe(command.length + 1);
  });

  it("opens a different token when the caret moves directly to it", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${command} @src`);

    expect(composer.trigger?.query).toBe("src");
  });

  it("can reopen after the caret leaves the dismissed word", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(initialPrompt, 0);
    await updatePrompt(initialPrompt);

    expect(composer.trigger?.query).toBe("openai");
  });

  it("can reopen at the same position after deleting and retyping @", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));
    const prefix = initialPrompt.slice(0, initialPrompt.indexOf("@"));
    await updatePrompt(prefix);
    await updatePrompt(`${prefix}@`);

    expect(composer.trigger?.query).toBe("");
  });

  it("clears dismissal when switching drafts or pending questions", async () => {
    await using _screen = await renderComposer();
    await act(() => composer.dismissTrigger(composer.trigger));
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    await act(() => composer.resetTrigger(candidate));

    expect(composer.trigger).toEqual(candidate);
    expect(composer.resolveTrigger(candidate)).toEqual(candidate);
  });

  it.each(["/plan", "$skill", "#123"])("also dismisses %s suggestions", async (text) => {
    await using _screen = await renderComposer();
    await updatePrompt(text);
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${text}x`);

    expect(composer.trigger).toBeNull();
    await updatePrompt("@src");
    expect(composer.trigger?.kind).toBe("path");
  });
});
