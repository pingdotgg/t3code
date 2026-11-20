// Runtime helpers for launch-video stories. capture.mjs seeks every animation on the page,
// including the Web Animations created here, so nothing in a story may depend on real time.
window.Kit = (() => {
  const centerOf = (target, dx = 0, dy = 0) => {
    if (Array.isArray(target)) return target;
    const el = document.querySelector(target);
    if (!el) throw new Error(`Kit: no element matches ${target}`);
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2 + dx, r.top + r.height / 2 + dy];
  };

  // Measure with the camera at rest: capture.mjs seeks to window.layoutTime, then calls this.
  const measure = (fn) => {
    const cams = [...document.querySelectorAll(".cam")];
    for (const cam of cams) cam.style.animation = "none";
    try {
      return fn();
    } finally {
      for (const cam of cams) cam.style.animation = "";
    }
  };

  // Steps, in animation seconds:
  //   { t, at: [x, y] | selector, dx, dy, click, hidden }
  //   at omitted = stay put (a hold). click = press at t. hidden = fade the cursor out by t.
  const cursor = (selector, steps, { ease = "cubic-bezier(.45,0,.2,1)" } = {}) => {
    const el = document.querySelector(selector);
    for (const a of el.getAnimations()) a.cancel();
    const end = steps.at(-1).t;
    const frames = [];
    let pos = [0, 0];
    let opacity = 0;
    const push = (t, scale = 1) =>
      frames.push({
        offset: t / end,
        transform: `translate(${pos[0] - 4}px, ${pos[1] - 3}px) scale(${scale})`,
        opacity,
        easing: ease,
      });
    steps.forEach((s, i) => {
      if (s.at !== undefined) pos = centerOf(s.at, s.dx, s.dy);
      if (i === 0) {
        push(0);
        opacity = s.hidden ? 0 : 1;
        push(s.t);
        return;
      }
      opacity = s.hidden ? 0 : 1;
      push(s.t);
      if (s.click) {
        push(s.t + 0.07, 0.8);
        push(s.t + 0.22, 1);
      }
    });
    frames.sort((a, b) => a.offset - b.offset);
    for (const f of frames) f.offset = Math.min(1, Math.max(0, f.offset));
    el.animate(frames, { duration: end * 1000, fill: "both" });
  };

  // Segments: [realSeconds, animFrom, animTo]; animFrom == animTo holds the frame.
  const timeline = (segments) => {
    window.totalDuration = segments.reduce((n, [d]) => n + d, 0);
    const last = segments.at(-1)[2];
    window.warp = (t) => {
      for (const [d, a, b] of segments) {
        if (t <= d) return a + (b - a) * (t / d);
        t -= d;
      }
      return last;
    };
  };

  return { centerOf, measure, cursor, timeline };
})();
