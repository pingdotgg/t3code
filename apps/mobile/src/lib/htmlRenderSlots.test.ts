import { describe, expect, it } from "vite-plus/test";

import { HtmlRenderSlots } from "./htmlRenderSlots";

describe("HtmlRenderSlots", () => {
  it("keeps pages live after they scroll away until another page needs the slot", () => {
    const slots = new HtmlRenderSlots(2);
    slots.setVisible("a", true);
    slots.setVisible("a", false);
    slots.setVisible("b", true);
    expect(slots.isLive("a")).toBe(true);

    slots.setVisible("c", true);
    expect(slots.isLive("a")).toBe(false);
    expect(slots.isLive("b")).toBe(true);
    expect(slots.isLive("c")).toBe(true);
  });

  it("evicts an off-screen page before an older visible one", () => {
    const slots = new HtmlRenderSlots(2);
    slots.setVisible("a", true);
    slots.setVisible("b", true);
    slots.setVisible("b", false);
    slots.setVisible("c", true);
    expect(slots.isLive("a")).toBe(true);
    expect(slots.isLive("b")).toBe(false);
  });

  it("takes the oldest slot when every live page is visible, and a tap takes it back", () => {
    const slots = new HtmlRenderSlots(2);
    slots.setVisible("a", true);
    slots.setVisible("b", true);
    slots.setVisible("c", true);
    expect(slots.isLive("a")).toBe(false);

    slots.claim("a");
    expect(slots.isLive("a")).toBe(true);
    expect(slots.isLive("b")).toBe(false);
  });

  it("frees a slot when a row unmounts", () => {
    const slots = new HtmlRenderSlots(1);
    let notified = 0;
    slots.subscribe(() => notified++);
    slots.setVisible("a", true);
    slots.release("a");
    expect(slots.isLive("a")).toBe(false);
    expect(notified).toBe(2);
  });
});
