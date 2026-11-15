import { observeResize } from "~/lib/observeResize";

/** One star of the spiral, in galaxy-relative polar coordinates. */
interface GalaxyStar {
  readonly radius: number;
  readonly angle: number;
  readonly size: number;
  readonly hue: number;
  readonly light: number;
}

interface FieldStar {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly phase: number;
}

const ARMS = 4;
const TWIST = 5.5;
const FRAME_INTERVAL_MS = 1000 / 30;

// A small seeded generator, so the galaxy looks the same on every launch.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStars(count: number, fieldCount: number) {
  const next = random(20261114);
  const stars: GalaxyStar[] = [];
  for (let index = 0; index < count; index += 1) {
    const radius = Math.pow(next(), 1.6);
    const arm = (index % ARMS) * ((Math.PI * 2) / ARMS);
    const spread = (next() - 0.5) * (0.9 - radius * 0.5);
    stars.push({
      radius,
      angle: arm + radius * TWIST + spread,
      size: next() < 0.04 ? 1.8 : 0.6 + next() * 0.9,
      hue: radius < 0.25 ? 35 + next() * 20 : 200 + next() * 80,
      light: 60 + next() * 30,
    });
  }
  const field: FieldStar[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    field.push({ x: next(), y: next(), size: 0.4 + next() * 0.9, phase: next() * Math.PI * 2 });
  }
  return { stars, field };
}

/**
 * Draws a slowly turning spiral galaxy into `canvas` until the returned stop is called. It caps
 * itself at 30 frames a second, sleeps while the page is hidden, and draws one still frame when
 * the user prefers reduced motion.
 */
export function startGalaxy(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return () => {};
  const { stars, field } = makeStars(2600, 360);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let last = 0;
  let rotation = 0;
  let width = 0;
  let height = 0;

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const draw = (time: number) => {
    const sky = context.createRadialGradient(
      width * 0.5,
      height * 0.5,
      0,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.75,
    );
    sky.addColorStop(0, "#120a2a");
    sky.addColorStop(0.55, "#070414");
    sky.addColorStop(1, "#020108");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    for (const star of field) {
      const twinkle = 0.45 + 0.35 * Math.sin(time / 900 + star.phase);
      context.fillStyle = `rgba(255,255,255,${twinkle})`;
      context.fillRect(star.x * width, star.y * height, star.size, star.size);
    }

    const centerX = width * 0.5;
    const centerY = height * 0.52;
    const scale = Math.min(width, height) * 0.62;
    const core = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, scale * 0.35);
    core.addColorStop(0, "rgba(255,226,180,0.55)");
    core.addColorStop(0.4, "rgba(170,120,255,0.16)");
    core.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = core;
    context.fillRect(0, 0, width, height);

    for (const star of stars) {
      // Inner stars orbit faster, which keeps the arms winding as the disc turns.
      const angle = star.angle + rotation * (1.6 - star.radius);
      const x = centerX + Math.cos(angle) * star.radius * scale;
      const y = centerY + Math.sin(angle) * star.radius * scale * 0.55;
      context.fillStyle = `hsla(${star.hue},80%,${star.light}%,${0.9 - star.radius * 0.5})`;
      context.fillRect(x, y, star.size, star.size);
    }
  };

  const tick = (time: number) => {
    frame = requestAnimationFrame(tick);
    if (time - last < FRAME_INTERVAL_MS) return;
    const elapsed = last === 0 ? 0 : Math.min(time - last, 100);
    last = time;
    rotation += elapsed * 0.00004;
    draw(time);
  };

  const start = () => {
    cancelAnimationFrame(frame);
    last = 0;
    if (document.hidden) return;
    if (reducedMotion.matches) draw(0);
    else frame = requestAnimationFrame(tick);
  };

  resize();
  draw(0);
  start();
  const stopObserving = observeResize(canvas, () => {
    resize();
    draw(last);
  });
  document.addEventListener("visibilitychange", start);
  reducedMotion.addEventListener("change", start);
  return () => {
    cancelAnimationFrame(frame);
    stopObserving();
    document.removeEventListener("visibilitychange", start);
    reducedMotion.removeEventListener("change", start);
  };
}
