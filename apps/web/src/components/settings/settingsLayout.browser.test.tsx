import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scrollToSettingsTarget } from "./settingsLayout";

const PULSE = "settings-search-target-pulse";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(html: string) {
  document.body.innerHTML = html;
  return vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
}

function reduceMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches } as MediaQueryList);
}

describe("settings search targets", () => {
  it("scrolls a section's header into view, focuses the section, and pulses until blur", () => {
    reduceMotion(false);
    const scrollIntoView = mount(
      `<section id="providers" tabindex="-1"><h2>Providers</h2><p>Body</p></section>`,
    );
    const section = document.getElementById("providers")!;

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(section.querySelector("h2"));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.activeElement).toBe(section);
    expect(section.classList.contains(PULSE)).toBe(true);

    section.blur();
    expect(section.classList.contains(PULSE)).toBe(false);
  });

  it("restarts the pulse when the same destination is chosen again", () => {
    reduceMotion(false);
    mount(`<div id="word-wrap" tabindex="-1" class="${PULSE}"></div>`);
    const target = document.getElementById("word-wrap")!;
    const observer = new MutationObserver(() => {});
    observer.observe(target, { attributeFilter: ["class"], attributeOldValue: true });

    scrollToSettingsTarget("word-wrap");
    const previousClasses = observer.takeRecords().map((record) => record.oldValue);
    expect(previousClasses).toEqual([PULSE, ""]);
    expect(target.classList.contains(PULSE)).toBe(true);
  });

  it("does not animate the destination when reduced motion is requested", () => {
    reduceMotion(true);
    const scrollIntoView = mount(`<div id="word-wrap" tabindex="-1"></div>`);
    const target = document.getElementById("word-wrap")!;

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(document.activeElement).toBe(target);
    expect(target.classList.contains(PULSE)).toBe(false);
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
