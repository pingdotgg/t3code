// Runtime helpers for launch-video stories. capture.mjs seeks every animation on the page and in
// its beat iframes, including the Web Animations created here, so nothing may depend on real time.
//
// Targets: a CSS selector in the story ("#cur"), or "<beat> >> <selector>" for an element inside
// the frozen app page loaded as <iframe data-beat="<beat>">.
window.Kit = (() => {
  const frames = () => [...document.querySelectorAll("iframe[data-beat]")];
  const ready = Promise.all(
    frames().map(
      (f) =>
        new Promise((resolve) => {
          const done = async () => {
            await f.contentDocument.fonts.ready;
            resolve();
          };
          if (
            f.contentDocument?.readyState === "complete" &&
            f.contentDocument.body?.childElementCount
          )
            done();
          else f.addEventListener("load", done, { once: true });
        }),
    ),
  );

  const beat = (name) => {
    const f = document.querySelector(`iframe[data-beat="${name}"]`);
    if (!f) throw new Error(`Kit: no beat named ${name}`);
    return f;
  };
  // CSS plus a trailing `:text(words)`, which keeps the matches whose text contains `words`.
  const query = (doc, selector) => {
    const match = /^(.*?):text\((.+)\)$/.exec(selector.trim());
    if (!match) return [...doc.querySelectorAll(selector)];
    return [...doc.querySelectorAll(match[1] || "*")].filter(
      (node) =>
        node.textContent.includes(match[2]) &&
        ![...node.children].some(
          (c) => c.textContent.includes(match[2]) && c.matches(match[1] || "*"),
        ),
    );
  };
  const resolve = (target) => {
    // Nodes from a beat belong to its iframe's realm, so `instanceof Element` misses them.
    if (typeof target !== "string") {
      const view = target.ownerDocument.defaultView;
      return { el: target, frame: view === window ? null : view.frameElement };
    }
    const split = target.indexOf(" >> ");
    if (split === -1) {
      const [el] = query(document, target);
      if (!el) throw new Error(`Kit: no element matches ${target}`);
      return { el, frame: null };
    }
    const frame = beat(target.slice(0, split));
    const sel = target.slice(split + 4);
    const [el] = query(frame.contentDocument, sel);
    if (!el) throw new Error(`Kit: no element matches ${sel} in beat ${frame.dataset.beat}`);
    return { el, frame };
  };
  // "* >> <selector>" matches in every beat.
  const all = (target) => {
    const split = target.indexOf(" >> ");
    if (split === -1) return query(document, target);
    const name = target.slice(0, split);
    const docs =
      name === "*" ? frames().map((f) => f.contentDocument) : [beat(name).contentDocument];
    return docs.flatMap((doc) => query(doc, target.slice(split + 4)));
  };
  // Extra CSS in beats ("*" for all), e.g. to uncap a scrolling modal so the whole page shows.
  const css = (name, text) => {
    for (const f of name === "*" ? frames() : [beat(name)]) {
      const style = f.contentDocument.createElement("style");
      style.textContent = text;
      f.contentDocument.head.append(style);
    }
  };
  // A static edit to the frozen page, e.g. a dev-only label. Say so when you hand the video back.
  const text = (targets, value) => {
    for (const node of all(targets)) node.textContent = value;
  };
  const el = (target) => resolve(target).el;

  // Story-page coordinates of a target's box, through any iframe and its scale.
  const rect = (target) => {
    const { el: node, frame } = resolve(target);
    const r = node.getBoundingClientRect();
    if (!frame) return r;
    const f = frame.getBoundingClientRect();
    const s = f.width / frame.offsetWidth;
    return new DOMRect(f.left + r.left * s, f.top + r.top * s, r.width * s, r.height * s);
  };
  const centerOf = (target, dx = 0, dy = 0) => {
    if (Array.isArray(target)) return target;
    const r = rect(target);
    return [r.left + r.width / 2 + dx, r.top + r.height / 2 + dy];
  };

  // Measure with the camera at rest: capture.mjs seeks to window.layoutTime, then calls this.
  const measure = (fn) => {
    const cams = [...document.querySelectorAll(".cam")];
    const scripted = cams.flatMap((cam) =>
      cam.getAnimations().filter((a) => !(a instanceof CSSAnimation)),
    );
    for (const cam of cams) cam.style.animation = "none";
    for (const a of scripted) a.cancel();
    // Everything is measured with the camera at rest; camera moves start only afterwards.
    measuring = true;
    try {
      for (const place of overlays.splice(0)) place();
      return fn();
    } finally {
      measuring = false;
      for (const start of afterMeasure.splice(0)) start();
      for (const cam of cams) cam.style.animation = "";
    }
  };
  let measuring = false;
  const afterMeasure = [];
  // Overlays drawn on the story page over a target (so the app's own overflow cannot clip
  // them). They are measured and placed when placeCursor runs Kit.measure.
  const overlays = [];
  const overlay = (target, style, keyframes, timing) =>
    overlays.push(() => {
      const r = rect(target);
      const node = resolve(target).el;
      const radius = parseFloat(getComputedStyle(node).borderRadius) || 10;
      const scale = r.width / node.getBoundingClientRect().width;
      const box = document.createElement("div");
      box.className = "kit-overlay";
      Object.assign(box.style, {
        position: "absolute",
        left: `${r.left - 6}px`,
        top: `${r.top - 6}px`,
        width: `${r.width + 12}px`,
        height: `${r.height + 12}px`,
        borderRadius: `${radius * scale + 6}px`,
        pointerEvents: "none",
        zIndex: 15,
        opacity: 0,
        ...style,
      });
      (document.querySelector(".cam") ?? document.body).append(box);
      anim(box, keyframes, timing);
    });

  // One Web Animation at an absolute time (animation seconds). fill "both" holds the first
  // keyframe before `at` and the last after it ends.
  const anim = (
    target,
    keyframes,
    { at = 0, dur = 0.4, ease = "cubic-bezier(.2,.8,.2,1)", fill = "both" } = {},
  ) => {
    const node = typeof target === "string" ? el(target) : target;
    return node.animate(keyframes, { delay: at * 1000, duration: dur * 1000, easing: ease, fill });
  };
  const SPRING = "linear(0, .25 7%, .7 16%, 1.03 28%, 1.08 34%, 1.04 44%, .99 58%, 1)";
  // One visibility window per element: hidden, then shown from `from` (fading in over `fade`),
  // then hidden again at `to`. Two separate show/hide animations on one element fight.
  const visible = (target, from, to = Infinity, fade = 0) => {
    const shown = from + fade;
    const open = !Number.isFinite(to);
    const end = open ? shown + 1 : to;
    const keys = [
      { offset: 0, opacity: 0 },
      { offset: from / end, opacity: 0 },
      { offset: shown / end, opacity: 1 },
      // Every keyframe list ends at offset 1, or the fill falls back to the element's CSS.
      ...(open
        ? [{ offset: 1, opacity: 1 }]
        : [
            { offset: Math.max(shown, to - 0.001) / end, opacity: 1 },
            { offset: 1, opacity: 0 },
          ]),
    ];
    return anim(target, keys, { at: 0, dur: end, ease: "linear" });
  };
  // Captions in order: [[selector, from, to], ...]. Each fades in and out inside its window,
  // and overlapping windows throw, since two captions on screen read as garbled text.
  const captions = (list) =>
    list.forEach(([target, from, to], i) => {
      const next = list[i + 1];
      if (next && next[1] < to) throw new Error(`Kit: caption ${target} overlaps ${next[0]}`);
      anim(
        target,
        [
          { opacity: 0, transform: "translateY(14px)" },
          { opacity: 1, transform: "none", offset: 0.06 },
          { opacity: 1, transform: "none", offset: 0.94 },
          { opacity: 0, transform: "translateY(-8px)" },
        ],
        { at: from, dur: to - from, ease: "linear" },
      );
    });
  // The beats in order: [[name, at, fade?], ...]. Each shows from its `at` until the next beat
  // has finished fading in over it.
  const beats = (sequence) =>
    sequence.forEach(([name, at, fade = 0], i) => {
      const next = sequence[i + 1];
      visible(beat(name), at, next ? next[1] + (next[2] ?? 0) : Infinity, fade);
    });

  const motion = {
    // Appear: at `at` the element is hidden until then.
    show: (t, at) => anim(t, [{ opacity: 0 }, { opacity: 1 }], { at, dur: 0.01 }),
    hide: (t, at) => anim(t, [{ opacity: 1 }, { opacity: 0 }], { at, dur: 0.01 }),
    fadeIn: (t, at, dur = 0.3) =>
      anim(t, [{ opacity: 0 }, { opacity: 1 }], { at, dur, ease: "ease-out" }),
    fadeOut: (t, at, dur = 0.3) =>
      anim(t, [{ opacity: 1 }, { opacity: 0 }], { at, dur, ease: "ease-in" }),
    // Spring pop: scales up from `from` with an overshoot.
    pop: (t, at, { from = 0.6, dur = 0.55, origin = "center" } = {}) => {
      el(t).style.transformOrigin = origin;
      return anim(
        t,
        [
          { opacity: 0, transform: `scale(${from})` },
          { opacity: 1, offset: 0.25 },
          { opacity: 1, transform: "none" },
        ],
        { at, dur, ease: SPRING },
      );
    },
    // Rise into place from below (or any offset), springy.
    rise: (t, at, { y = 24, x = 0, dur = 0.6 } = {}) =>
      anim(
        t,
        [
          { opacity: 0, transform: `translate(${x}px, ${y}px)` },
          { opacity: 1, offset: 0.3 },
          { opacity: 1, transform: "none" },
        ],
        { at, dur, ease: SPRING },
      ),
    // Slide in from a side, e.g. a panel: { x: 400 } comes from the right.
    slide: (t, at, { x = 0, y = 0, dur = 0.5 } = {}) =>
      anim(t, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], {
        at,
        dur,
        ease: "cubic-bezier(.16,1,.3,1)",
      }),
    // The same entrance on each match, `step` seconds apart.
    stagger: (targets, at, step = 0.07, fn = "rise", opts) =>
      all(targets).map((node, i) => motion[fn](node, at + i * step, opts)),
    // Typewriter: reveals the element left to right in `chars` steps.
    type: (t, at, dur, chars = 30) =>
      anim(t, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], {
        at,
        dur,
        ease: `steps(${chars}, end)`,
      }),
    // Button squash on click.
    press: (t, at) =>
      anim(
        t,
        [{ transform: "none" }, { transform: "scale(.9)", offset: 0.35 }, { transform: "none" }],
        { at, dur: 0.3, ease: "ease-out", fill: "none" },
      ),
    // Primary-blue glow ring that blooms and settles around the element (an overlay).
    glow: (t, at, dur = 1.4) =>
      overlay(
        t,
        {
          border: "2px solid rgba(110,155,251,.95)",
          boxShadow: "0 0 32px 6px rgba(52,107,241,.55), inset 0 0 18px rgba(52,107,241,.25)",
        },
        [
          { opacity: 0, transform: "scale(1.06)" },
          { opacity: 1, transform: "none", offset: 0.18 },
          { opacity: 1, transform: "none", offset: 0.75 },
          { opacity: 0, transform: "none" },
        ],
        { at, dur, ease: "ease-out" },
      ),
    // Draws solid SVG strokes in (dashed ones keep their dashes and just fade in).
    draw: (targets, at, dur = 0.6, step = 0.08) =>
      all(targets).map((path, i) => {
        const start = at + i * step;
        const view = path.ownerDocument.defaultView;
        if (view.getComputedStyle(path).strokeDasharray !== "none" || !path.getTotalLength) {
          return anim(path, [{ opacity: 0 }, { opacity: 1 }], { at: start, dur });
        }
        const length = path.getTotalLength();
        path.style.strokeDasharray = `${length}`;
        return anim(path, [{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
          at: start,
          dur,
          ease: "cubic-bezier(.4,0,.2,1)",
        });
      }),
    // Wipes an element in from one side (dashed lines, a drag line following the pointer).
    reveal: (t, at, dur = 0.5, from = "left") => {
      const start = {
        left: "inset(0 100% 0 0)",
        right: "inset(0 0 0 100%)",
        top: "inset(0 0 100% 0)",
        bottom: "inset(100% 0 0 0)",
      }[from];
      return anim(t, [{ clipPath: start }, { clipPath: "inset(0 0 0 0)" }], {
        at,
        dur,
        ease: "linear",
      });
    },
    // A punch: brief scale-up pulse that draws the eye.
    punch: (t, at, scale = 1.06) =>
      anim(
        t,
        [
          { transform: "none" },
          { transform: `scale(${scale})`, offset: 0.3 },
          { transform: "none" },
        ],
        { at, dur: 0.45, ease: "ease-out", fill: "none" },
      ),
  };

  // Click ripple drawn on the story page at a target's centre (call from setup or placeCursor).
  const ripple = (target, at, { dx = 0, dy = 0 } = {}) => {
    const [x, y] = centerOf(target, dx, dy);
    const ring = document.createElement("div");
    ring.className = "kit-ripple";
    Object.assign(ring.style, {
      position: "absolute",
      left: `${x - 30}px`,
      top: `${y - 30}px`,
      width: "60px",
      height: "60px",
      borderRadius: "50%",
      border: "3px solid rgba(110,155,251,.9)",
      pointerEvents: "none",
      zIndex: 25,
    });
    (document.querySelector(".cam") ?? document.body).append(ring);
    return anim(
      ring,
      [
        { opacity: 0, transform: "scale(.2)" },
        { opacity: 1, offset: 0.15 },
        { opacity: 0, transform: "scale(1.6)" },
      ],
      { at, dur: 0.55, ease: "ease-out" },
    );
  };

  // Steps, in animation seconds:
  //   { t, at: [x, y] | target, dx, dy, click, hidden }
  //   at omitted = stay put (a hold). click = press at t. hidden = fade the cursor out by t.
  const cursor = (selector, steps, { ease = "cubic-bezier(.45,0,.2,1)", ripples = true } = {}) => {
    const node = document.querySelector(selector);
    for (const a of node.getAnimations()) a.cancel();
    const end = steps.at(-1).t;
    const keys = [];
    let pos = [0, 0];
    let opacity = 0;
    const push = (t, scale = 1) =>
      keys.push({
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
        if (ripples) ripple(pos, s.t + 0.05);
      }
    });
    keys.sort((a, b) => a.offset - b.offset);
    for (const k of keys) k.offset = Math.min(1, Math.max(0, k.offset));
    node.animate(keys, { duration: end * 1000, fill: "both" });
  };

  // Camera keyframes on .cam, in animation seconds: { t, on: target | [x, y] | "full", s, y, ease }.
  // `on` is centred horizontally and placed at screen height `y` (default 420, clear of the
  // captions); "full" is the whole canvas. Repeat a step at a later t to hold. Call it inside
  // Kit.measure (placeCursor) so targets are measured with the camera at rest.
  const camera = (steps, { selector = ".cam" } = {}) => {
    const cam = document.querySelector(selector);
    for (const a of cam.getAnimations()) a.cancel();
    const end = steps.at(-1).t;
    const keys = steps.map((step) => {
      let transform = "none";
      if (step.on !== "full") {
        const s = step.s ?? 1.5;
        const [x, y] = centerOf(step.on, step.dx, step.dy);
        transform = `translate(${800 - s * x}px, ${(step.y ?? 420) - s * y}px) scale(${s})`;
      }
      return { offset: step.t / end, transform, easing: step.ease ?? "cubic-bezier(.65,0,.35,1)" };
    });
    const start = () => cam.animate(keys, { duration: end * 1000, fill: "both" });
    if (measuring) afterMeasure.push(start);
    else start();
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

  return {
    ready,
    beat,
    beats,
    visible,
    el,
    all,
    css,
    captions,
    text,
    rect,
    centerOf,
    measure,
    anim,
    ripple,
    cursor,
    camera,
    timeline,
    ...motion,
  };
})();
