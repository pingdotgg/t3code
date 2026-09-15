/**
 * Ordered transcript rendering (static markup, the repo's dumb-component
 * test pattern): chat utterances render in arrival order with speaker
 * labels, and the scroll-follow decision never yanks a reader away from
 * scrolled-up history.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { isNearBottom, VoiceTranscript } from "./VoiceTranscript";
import type { VoiceUtterance } from "./voicePanelController";

const utterance = (id: string, channel: "input" | "output", text: string): VoiceUtterance => ({
  id: `${channel}:${id}`,
  channel,
  text,
});

const render = (utterances: ReadonlyArray<VoiceUtterance>) =>
  renderToStaticMarkup(
    <VoiceTranscript
      utterances={utterances}
      inFlightTool={null}
      error={null}
      navigationStatus={null}
      navigationFailed={false}
    />,
  );

describe("voice transcript rendering", () => {
  it("renders nothing without any content", () => {
    expect(render([])).toBe("");
  });

  it("renders interleaved utterances in arrival order with speaker labels", () => {
    const markup = render([
      utterance("in-1", "input", "catch me up on Oracle"),
      utterance("out-1", "output", "On the Oracle project,"),
      utterance("in-2", "input", "just the risks"),
      utterance("out-2", "output", "two risks stand out."),
    ]);
    const order: Array<string> = [];
    for (const match of markup.matchAll(/data-voice-speaker="(input|output)"/g)) {
      order.push(match[1] ?? "");
    }
    expect(order).toEqual(["input", "output", "input", "output"]);
    expect(markup).toContain("You: ");
    expect(markup).toContain("Assistant: ");
    expect(markup.indexOf("catch me up on Oracle")).toBeLessThan(
      markup.indexOf("On the Oracle project,"),
    );
    expect(markup.indexOf("On the Oracle project,")).toBeLessThan(markup.indexOf("just the risks"));
    expect(markup.indexOf("just the risks")).toBeLessThan(markup.indexOf("two risks stand out."));
  });

  it("keys each utterance entry for streaming updates in place", () => {
    const markup = render([utterance("in-1", "input", "hello")]);
    expect(markup).toContain('data-voice-utterance="input:in-1"');
  });

  it("bounds the scroll container so a long session cannot grow the panel", () => {
    const markup = render([utterance("in-1", "input", "hello")]);
    expect(markup).toContain("max-h-64");
    expect(markup).toContain("overflow-y-auto");
  });
});

describe("transcript scroll-follow decision", () => {
  it("follows the stream when the reader is at the bottom", () => {
    expect(isNearBottom({ scrollTop: 990, scrollHeight: 1000, clientHeight: 20 })).toBe(true);
  });

  it("does not follow when the reader scrolled up into history", () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 20 })).toBe(false);
  });
});
