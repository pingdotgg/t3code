/**
 * Disabled-state matrix for the voice control row (static markup, the repo's
 * dumb-component test pattern): End must stay available to cancel a pending
 * connection (starting === true), including the initial idle-starting state
 * before a client exists.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { VoiceControls } from "./VoiceControls";
import type { VoiceActivationMode } from "./overlayPreferences";

type Phase = "idle" | "connecting" | "live" | "closing" | "closed" | "error";

const renderControls = (phase: Phase, starting = false, activation?: VoiceActivationMode): string =>
  renderToStaticMarkup(
    <VoiceControls
      phase={phase}
      starting={starting}
      micMuted={false}
      activation={activation}
      onConnect={() => {}}
      onToggleMute={() => {}}
      onEnd={() => {}}
      onClear={() => {}}
      onTalkPress={() => {}}
      onTalkRelease={() => {}}
      onTalkToggle={() => {}}
    />,
  );

/** Extracts label -> disabled for every rendered button (React omits the
    disabled attribute entirely when a button is enabled; the Tailwind
    `disabled:` class names in className must not count). */
const buttonStates = (markup: string): Record<string, boolean> => {
  const states: Record<string, boolean> = {};
  for (const match of markup.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) {
    const label = match[2]?.trim() ?? "";
    if (label.length > 0) {
      states[label] = /(^|\s)disabled(?=$|[\s>]|="")/.test(match[1] ?? "");
    }
  }
  return states;
};

describe("voice controls disabled-state matrix", () => {
  it("idle and not starting: nothing to cancel — End disabled, Connect enabled", () => {
    const states = buttonStates(renderControls("idle"));
    expect(states).toEqual({
      Connect: false,
      Mute: true,
      End: true,
      Clear: false,
    });
  });

  it("idle and starting (pending permission prompt): End is the cancel — enabled, Connect disabled", () => {
    const states = buttonStates(renderControls("idle", true));
    expect(states).toEqual({
      Connect: true,
      Mute: true,
      End: false,
      Clear: false,
    });
  });

  it("connecting: End enabled as cancel", () => {
    const states = buttonStates(renderControls("connecting"));
    expect(states.End).toBe(false);
    expect(states.Connect).toBe(true);
  });

  it("live: End enabled, Mute enabled", () => {
    const states = buttonStates(renderControls("live"));
    expect(states.End).toBe(false);
    expect(states.Mute).toBe(false);
    expect(states.Connect).toBe(true);
    expect(states.Clear).toBe(true);
  });

  it("closing: End enabled", () => {
    const states = buttonStates(renderControls("closing"));
    expect(states.End).toBe(false);
  });

  it("closed and not starting: End disabled, Connect enabled", () => {
    const states = buttonStates(renderControls("closed"));
    expect(states.End).toBe(true);
    expect(states.Connect).toBe(false);
  });

  it("closed and starting (pending reconnect): End enabled as cancel", () => {
    const states = buttonStates(renderControls("closed", true));
    expect(states.End).toBe(false);
    expect(states.Connect).toBe(true);
  });

  it("error and not starting: Connect enabled, End enabled", () => {
    const states = buttonStates(renderControls("error"));
    expect(states.Connect).toBe(false);
    expect(states.End).toBe(false);
  });

  it("error and starting: End enabled as cancel", () => {
    const states = buttonStates(renderControls("error", true));
    expect(states.Connect).toBe(true);
    expect(states.End).toBe(false);
  });
});

describe("voice controls activation modes", () => {
  it("manual keeps the plain Connect button", () => {
    const states = buttonStates(renderControls("idle", false, "manual"));
    expect(states).toEqual({
      Connect: false,
      Mute: true,
      End: true,
      Clear: false,
    });
  });

  it("always listening has no Connect button (the panel connects on its own)", () => {
    const states = buttonStates(renderControls("idle", false, "always"));
    expect(states).toEqual({
      Mute: true,
      End: true,
      Clear: false,
    });
  });

  it("hold mode offers the hold-to-talk button instead of Connect", () => {
    const states = buttonStates(renderControls("idle", false, "hold"));
    expect(states).toEqual({
      "Hold to talk": false,
      Mute: true,
      End: true,
      Clear: false,
    });
  });

  it("double-press mode offers the Talk button instead of Connect", () => {
    const markup = renderControls("idle", false, "double-press");
    const states = buttonStates(markup);
    expect(states).toEqual({
      Talk: false,
      Mute: true,
      End: true,
      Clear: false,
    });
    expect(markup).toContain("Double-click Talk to listen");
  });

  it("hold mode keeps the row during a live session (release ends it)", () => {
    const states = buttonStates(renderControls("live", false, "hold"));
    expect(states["Hold to talk"]).toBe(false);
    expect(states.Mute).toBe(false);
    expect(states.End).toBe(false);
  });
});
