import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scrollToSettingsTarget, SettingsRow, SettingsUnavailableGroup } from "./settingsLayout";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unavailable settings", () => {
  it("groups disabled controls under one reason", () => {
    const markup = renderToStaticMarkup(
      <SettingsUnavailableGroup message="Only available in the desktop app.">
        <SettingsRow title="Window capture" description="Capture a window." />
      </SettingsUnavailableGroup>,
    );

    expect(markup).toContain("Only available in the desktop app.");
    expect(markup).toContain("border-border/60");
    expect(markup).toContain("[&amp;_h3]:opacity-64");
  });
});

describe("settings search targets", () => {
  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("scrolls again once an opening collapsible panel finishes growing", () => {
    const scrollIntoView = vi.fn();
    let onTransitionEnd: ((event: { target: unknown }) => void) | undefined;
    const panel = {
      addEventListener: vi.fn((_type: string, listener: typeof onTransitionEnd) => {
        onTransitionEnd = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const closest = vi.fn(() => panel);
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      parentElement: { closest },
      scrollIntoView,
      focus: vi.fn(),
      classList: { remove: vi.fn(), add: vi.fn() },
      addEventListener: vi.fn(),
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("legacy-sidebar")).toBe(true);
    expect(closest).toHaveBeenCalledWith('[data-slot="collapsible-panel"][data-starting-style]');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    onTransitionEnd?.({ target: {} });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    onTransitionEnd?.({ target: panel });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(panel.removeEventListener).toHaveBeenCalledWith("transitionend", onTransitionEnd);
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
