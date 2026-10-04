import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { matchComposerThreadItems } from "@t3tools/client-runtime/composerThreadItems";

import { detectComposerTrigger } from "../../composer-logic";
import { useComposerTriggerState } from "./useComposerTriggerState";

const command = "pnpm install -g @openai/codex@latest";
const initialPrompt = "pnpm install -g @openai";
let root: Root;
let composer: ReturnType<typeof useComposerTriggerState>;

function ComposerProbe() {
  const state = useComposerTriggerState(initialPrompt);
  useLayoutEffect(() => {
    composer = state;
  });
  return null;
}

async function updatePrompt(text: string, cursor = text.length) {
  await act(() => composer.setTrigger(composer.detectTrigger(text, cursor)));
}

beforeEach(async () => {
  // The probe renders no DOM nodes, but ReactDOM still needs an event target.
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  await act(() =>
    root.render(
      <StrictMode>
        <ComposerProbe />
      </StrictMode>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("composer suggestion dismissal", () => {
  it("keeps a multi-word @ search active and replaces its whole range", async () => {
    const prefix = "Please inspect ";
    const query = "Foreign Subsidiaries Motion Video";
    for (let length = 0; length <= query.length; length += 1) {
      const text = `${prefix}@${query.slice(0, length)}`;
      await updatePrompt(text);
      expect(composer.trigger).toEqual({
        kind: "path",
        query: query.slice(0, length),
        rangeStart: prefix.length,
        rangeEnd: text.length,
      });
    }
    const environmentId = EnvironmentId.make("env-1");
    const items = matchComposerThreadItems({
      environmentId,
      excludeThreadId: null,
      query: composer.trigger!.query,
      shells: [query, "Foreign Subsidiaries Training"].map((title, index) => ({
        environmentId,
        id: ThreadId.make("thread-" + index),
        title,
        archivedAt: null,
        updatedAt: "2026-10-03T00:00:00.000Z",
      })),
    });
    expect(items.map((item) => item.label)).toEqual([query]);
  });

  it("closes when the caret jumps into existing prose and rejects keyboard selection", async () => {
    const suffix = " then summarize";
    await updatePrompt("@Foreign" + suffix, "@Foreign".length);
    await updatePrompt("@Foreign Subsidiaries" + suffix, "@Foreign Subsidiaries".length);
    expect(composer.trigger?.query).toBe("Foreign Subsidiaries");
    // Keyboard selection re-reads the editor before its next selection render.
    const text = "@Foreign Subsidiaries" + suffix;
    expect(composer.resolveTrigger(composer.detectTrigger(text, text.length))).toBeNull();
    await updatePrompt(text);
    expect(composer.trigger).toBeNull();
  });

  it("preserves the suffix when editing a query before existing prose", async () => {
    const suffix = " then summarize";
    await updatePrompt("@Foreign" + suffix, "@Foreign".length);
    await updatePrompt("@Foreign " + suffix, "@Foreign ".length);
    await updatePrompt("@Foreign Subsidiaries" + suffix, "@Foreign Subsidiaries".length);
    expect(composer.trigger?.rangeEnd).toBe("@Foreign Subsidiaries".length);
    await updatePrompt("@Foreign Subsidiaries" + suffix, 0);
    await updatePrompt("@Foreign Subsidiaries" + suffix);
    expect(composer.trigger).toBeNull();
  });

  it("does not reopen a dismissed multi-word search as typing continues", async () => {
    await updatePrompt("@Foreign");
    await updatePrompt("@Foreign ");
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt("@Foreign Subsidiaries");
    expect(composer.trigger).toBeNull();
    await updatePrompt("@Foreign Subsidiaries @src");
    expect(composer.trigger?.query).toBe("src");
  });

  it("closes after selection and leaves following prose outside the search", async () => {
    await updatePrompt("@Foreign");
    await updatePrompt("@Foreign Subsidiaries");
    await updatePrompt("[Foreign Subsidiaries](Foreign%20Subsidiaries) ");
    await updatePrompt("[Foreign Subsidiaries](Foreign%20Subsidiaries) please inspect");
    expect(composer.trigger).toBeNull();
  });

  it("closes suggestions and rejects keyboard selection before the next render", async () => {
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    expect(composer.trigger).toEqual(candidate);

    await act(() => {
      composer.dismissTrigger(candidate);
      expect(composer.resolveTrigger(candidate)).toBeNull();
    });
    expect(composer.trigger).toBeNull();
  });

  it("stays dismissed while typing a scoped package, including its second @", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));

    for (let cursor = initialPrompt.length; cursor <= command.length; cursor += 1) {
      const text = command.slice(0, cursor);
      await updatePrompt(text);
      expect(composer.trigger).toBeNull();
      expect(composer.resolveTrigger(detectComposerTrigger(text, cursor))).toBeNull();
    }
  });

  it("stays dismissed while deleting characters or moving within the same word", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));

    for (let cursor = initialPrompt.length - 1; cursor > initialPrompt.indexOf("@"); cursor -= 1) {
      await updatePrompt(initialPrompt, cursor);
      expect(composer.trigger).toBeNull();
      await updatePrompt(initialPrompt.slice(0, cursor));
      expect(composer.trigger).toBeNull();
    }
  });

  it("opens suggestions for a new @ word after a space", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${command} `);
    await updatePrompt(`${command} @src`);

    expect(composer.trigger?.query).toBe("src");
    expect(composer.trigger?.rangeStart).toBe(command.length + 1);
  });

  it("opens a different token when the caret moves directly to it", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${command} @src`);

    expect(composer.trigger?.query).toBe("src");
  });

  it("can reopen after the caret leaves the dismissed word", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(initialPrompt, 0);
    await updatePrompt(initialPrompt);

    expect(composer.trigger?.query).toBe("openai");
  });

  it("can reopen at the same position after deleting and retyping @", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    const prefix = initialPrompt.slice(0, initialPrompt.indexOf("@"));
    await updatePrompt(prefix);
    await updatePrompt(`${prefix}@`);

    expect(composer.trigger?.query).toBe("");
  });

  it("clears dismissal when switching drafts or pending questions", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    await act(() => composer.resetTrigger(candidate, initialPrompt));

    expect(composer.trigger).toEqual(candidate);
    expect(composer.resolveTrigger(candidate)).toEqual(candidate);
  });

  it.each(["/plan", "$skill", "#123"])("also dismisses %s suggestions", async (text) => {
    await updatePrompt(text);
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${text}x`);

    expect(composer.trigger).toBeNull();
    await updatePrompt("@src");
    expect(composer.trigger?.kind).toBe("path");
  });
});
