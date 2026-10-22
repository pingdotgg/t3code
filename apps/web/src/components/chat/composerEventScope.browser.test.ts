import { describe, expect, it } from "vite-plus/test";

import { composerTakesShortcut } from "./composerEventScope";

function mount(sideChatFocused: boolean) {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-host-timeline tabindex="-1"></div>
    <div data-host-anchor ${sideChatFocused ? "hidden" : ""}><form data-host-form></form></div>
    <div data-chat-embedded="side">
      <div data-side-timeline tabindex="-1"></div>
      ${sideChatFocused ? "<form data-side-form></form>" : ""}
    </div>`;
  document.body.append(host);
  return {
    hostTimeline: host.querySelector("[data-host-timeline]"),
    sideTimeline: host.querySelector("[data-side-timeline]"),
    hostForm: host.querySelector("[data-host-form]"),
    sideForm: host.querySelector("[data-side-form]"),
    [Symbol.dispose]: () => host.remove(),
  };
}

describe("composer shortcut ownership with a side chat", () => {
  it("gives keys outside any side chat to the host while it has its composer", () => {
    using dom = mount(false);
    expect(composerTakesShortcut(dom.hostTimeline, dom.hostForm)).toBe(true);
    expect(composerTakesShortcut(null, dom.hostForm)).toBe(true);
    expect(composerTakesShortcut(dom.sideTimeline, dom.hostForm)).toBe(false);
  });

  it("gives keys outside any side chat to the side chat that has the composer", () => {
    using dom = mount(true);
    expect(composerTakesShortcut(dom.hostTimeline, dom.hostForm)).toBe(false);
    expect(composerTakesShortcut(dom.hostTimeline, dom.sideForm)).toBe(true);
    expect(composerTakesShortcut(dom.sideTimeline, dom.sideForm)).toBe(true);
    expect(composerTakesShortcut(dom.sideTimeline, dom.hostForm)).toBe(false);
  });
});
