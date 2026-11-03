export const frozenTime = Date.UTC(2026, 9, 21, 22, 30);

// Freeze wall-clock labels without changing animation or recording timing.
export function freezeClock() {
  const RealDate = globalThis.__evidenceRealDate ?? Date;
  globalThis.__evidenceRealDate = RealDate;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozenTime]));
    }
    static now() {
      return frozenTime;
    }
  };
}

export async function metadata(provenance) {
  await document.fonts.ready;
  const box = (selector) =>
    [...document.querySelectorAll(selector)].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  return {
    ...provenance,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    frozenTime: new Date().toISOString(),
    devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
    visualViewportScale: visualViewport.scale,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    rootClass: document.documentElement.className,
    fonts: [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => ({ family: f.family, style: f.style, weight: f.weight })),
    terminal: box("[data-thread-terminal-drawer]"),
    canvases: box("canvas"),
    composer: box('[role="textbox"][contenteditable="true"]'),
    scroll: [...document.querySelectorAll("*")]
      .filter((e) => e.scrollTop || e.scrollLeft)
      .map((e) => ({
        tag: e.tagName,
        className: e.className,
        top: e.scrollTop,
        left: e.scrollLeft,
      })),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}
