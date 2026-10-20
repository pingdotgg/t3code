import { describe, expect, it, vi } from "vite-plus/test";

import { scrollToSettingsTarget } from "./settingsLayout";

const PULSE = "settings-search-target-pulse";

function mount(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return { [Symbol.dispose]: () => container.remove() };
}

function reduceMotion(matches: boolean) {
  return vi.spyOn(window, "matchMedia").mockReturnValue({ matches } as MediaQueryList);
}

describe("settings search targets", () => {
  it("scrolls a section's header into view, focuses the section, and pulses until blur", () => {
    using _motion = reduceMotion(false);
    using _fixture = mount(
      `<section id="providers" tabindex="-1"><h2>Providers</h2><p>Body</p></section>`,
    );
    using scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
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
    using _motion = reduceMotion(false);
    using _fixture = mount(`<div id="word-wrap" tabindex="-1" class="${PULSE}"></div>`);
    const target = document.getElementById("word-wrap")!;
    const observer = new MutationObserver(() => {});
    using _observer = { [Symbol.dispose]: () => observer.disconnect() };
    observer.observe(target, { attributeFilter: ["class"], attributeOldValue: true });

    scrollToSettingsTarget("word-wrap");
    const previousClasses = observer.takeRecords().map((record) => record.oldValue);
    expect(previousClasses).toEqual([PULSE, ""]);
    expect(target.classList.contains(PULSE)).toBe(true);
  });

  it("does not animate the destination when reduced motion is requested", () => {
    using _motion = reduceMotion(true);
    using _fixture = mount(`<div id="word-wrap" tabindex="-1"></div>`);
    using scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const target = document.getElementById("word-wrap")!;

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(document.activeElement).toBe(target);
    expect(target.classList.contains(PULSE)).toBe(false);
  });

  it.each(["before", "after", "without animation"] as const)(
    "fully reveals the row when the opening style clears: %s",
    async (phase) => {
      // Keep scrolling synchronous while the panel height transitions independently.
      using _motion = reduceMotion(true);
      using _fixture = mount(`
        <div id="viewport" style="height: 200px; overflow: auto; overflow-anchor: none">
          <div id="panel" data-slot="collapsible-panel" data-open data-starting-style
            style="height: 0; overflow: hidden; transition: height 200ms linear">
            <div style="height: 500px"></div>
            <div id="legacy-sidebar" tabindex="-1" style="height: 40px">Legacy sidebar</div>
            <div style="height: 60px"></div>
          </div>
        </div>`);
      const viewport = document.getElementById("viewport")!;
      const panel = document.getElementById("panel")!;
      const target = document.getElementById("legacy-sidebar")!;

      void panel.offsetHeight;
      const animated = phase !== "without animation";
      if (animated) {
        panel.style.height = "600px";
      } else {
        panel.style.transition = "none";
      }
      const transition = panel.getAnimations()[0];
      if (animated) {
        expect(transition).toBeDefined();
        transition!.pause();
        transition!.currentTime = phase === "before" ? 0 : 100;
        if (phase === "after") panel.removeAttribute("data-starting-style");
      }

      expect(scrollToSettingsTarget("legacy-sidebar")).toBe(true);
      expect(document.activeElement).toBe(target);
      const opened = animated
        ? new Promise<void>((resolve) => {
            panel.addEventListener("transitionend", () => resolve(), { once: true });
          })
        : Promise.resolve();
      panel.style.height = "600px";
      panel.removeAttribute("data-starting-style");
      transition?.finish();
      await opened;

      const bounds = viewport.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      expect(row.top).toBeGreaterThanOrEqual(bounds.top);
      expect(row.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(document.activeElement).toBe(target);
    },
  );

  it("keeps the newer search destination visible when an earlier panel finishes opening", async () => {
    using _motion = reduceMotion(true);
    using _fixture = mount(`
      <div id="viewport" style="height: 200px; overflow: auto; overflow-anchor: none">
        <div id="new-target" tabindex="-1" style="height: 40px">New target</div>
        <div style="height: 1000px"></div>
        <div id="panel" data-slot="collapsible-panel" data-open data-starting-style
          style="height: 0; overflow: hidden; transition: height 200ms linear">
          <div style="height: 500px"></div>
          <div id="legacy-sidebar" tabindex="-1" style="height: 40px">Legacy sidebar</div>
          <div style="height: 60px"></div>
        </div>
      </div>`);
    const panel = document.getElementById("panel")!;
    void panel.offsetHeight;
    panel.style.height = "600px";
    const transition = panel.getAnimations()[0]!;
    transition.pause();
    transition.currentTime = 100;

    scrollToSettingsTarget("legacy-sidebar");
    panel.removeAttribute("data-starting-style");
    scrollToSettingsTarget("new-target");
    const opened = new Promise<void>((resolve) => {
      panel.addEventListener("transitionend", () => resolve(), { once: true });
    });
    transition.finish();
    await opened;

    const viewport = document.getElementById("viewport")!;
    const target = document.getElementById("new-target")!;
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      viewport.getBoundingClientRect().top,
    );
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
    expect(document.activeElement).toBe(target);
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
