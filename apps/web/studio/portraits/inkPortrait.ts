// Original scribble-ink *Bocchi the Rock!*-inspired manga portrait generator for custom areas.
export const ink = "#1d181b";
export const paper = "#fbf5eb";

type Brush = CanvasRenderingContext2D;
type Rng = () => number;

const swatches = ["#ff92b5", "#ffa044", "#65baff", "#68cfb5", "#ffc53c", "#b896f2", "#fc8a75", "#7fd49e"];

function createRng(seed: number): Rng {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shape(ctx: Brush, d: string, fill = ink, stroke = ink, width = 1.8, rng?: Rng) {
  const path = new Path2D(d);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(path);
  }
  if (stroke && width > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke(path);
    if (rng) {
      ctx.save();
      ctx.globalAlpha *= 0.48;
      ctx.translate((rng() - 0.5) * 1.5, (rng() - 0.5) * 1.5);
      ctx.lineWidth = Math.max(0.75, width * 0.55);
      ctx.stroke(path);
      ctx.restore();
    }
  }
}

function wobblyLine(
  ctx: Brush,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rng: Rng,
  amplitude: number,
  width: number,
  color = ink,
  alpha = 1,
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const steps = Math.max(6, Math.round(dist / 14));
  const phase = rng() * Math.PI * 2;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wave = Math.sin(t * Math.PI * 3 + phase) * 0.65 + (rng() - 0.5) * 0.7;
    const offset = amplitude * wave * (0.35 + 0.65 * Math.sin(t * Math.PI));
    const px = x0 + dx * t + nx * offset;
    const py = y0 + dy * t + ny * offset;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function halftoneField(ctx: Brush, color: string, gap: number, minR: number, maxR: number, vignetteOnly: boolean) {
  ctx.fillStyle = color;
  ctx.beginPath();
  let row = 0;
  for (let y = -gap; y <= 256 + gap; y += gap) {
    const offset = (row++ % 2) * (gap / 2);
    for (let x = -gap + offset; x <= 256 + gap; x += gap) {
      const edgeX = Math.min(x / 256, (256 - x) / 256);
      const edgeY = Math.min(y / 256, (256 - y) / 256);
      const weight = vignetteOnly
        ? Math.max(0, 1 - Math.min(edgeX, edgeY) / 0.24)
        : Math.max(0.2, Math.min(1, (1 - y / 256) * 0.72 + Math.abs(x / 256 - 0.5) * 0.78));
      if (vignetteOnly && weight <= 0.08) continue;
      const r = minR + (maxR - minR) * weight;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

function taperedWedge(
  ctx: Brush,
  tx: number,
  ty: number,
  bx: number,
  by: number,
  tw: number,
  bw: number,
  halo = true,
) {
  const dx = bx - tx;
  const dy = by - ty;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const trace = (pad: number) => {
    ctx.beginPath();
    ctx.moveTo(tx - ux * pad + nx * (tw + pad), ty - uy * pad + ny * (tw + pad));
    ctx.lineTo(bx + ux * pad + nx * (bw + pad), by + uy * pad + ny * (bw + pad));
    ctx.lineTo(bx + ux * pad - nx * (bw + pad), by + uy * pad - ny * (bw + pad));
    ctx.lineTo(tx - ux * pad - nx * (tw + pad), ty - uy * pad - ny * (tw + pad));
    ctx.closePath();
  };
  if (halo) {
    trace(1.6);
    ctx.fillStyle = paper;
    ctx.fill();
  }
  trace(0);
  ctx.fillStyle = ink;
  ctx.fill();
}

function fourPointStar(ctx: Brush, cx: number, cy: number, rx: number, ry: number, fill: string) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const scale = i % 2 === 0 ? 1 : 0.28;
    const x = cx + Math.cos(a) * rx * scale;
    const y = cy + Math.sin(a) * ry * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawSketchyFrame(ctx: Brush, rng: Rng) {
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 256, 3);
  ctx.fillRect(0, 253, 256, 3);
  ctx.fillRect(0, 0, 3, 256);
  ctx.fillRect(253, 0, 3, 256);

  const passes: ReadonlyArray<readonly [number, number, number, number]> = [
    [1.8, 0.9, 1.4, 0.96],
    [0.95, 1.45, 2.4, 0.58],
  ];
  const inset = 4.2;
  for (const [width, amp, over, alpha] of passes) {
    wobblyLine(ctx, inset - over, inset, 256 - inset + over, inset, rng, amp, width, ink, alpha);
    wobblyLine(ctx, 256 - inset, inset - over, 256 - inset, 256 - inset + over, rng, amp, width, ink, alpha);
    wobblyLine(ctx, 256 - inset + over, 256 - inset, inset - over, 256 - inset, rng, amp, width, ink, alpha);
    wobblyLine(ctx, inset, 256 - inset + over, inset, inset - over, rng, amp, width, ink, alpha);
  }
}

const backHairstyles = [
  // Side twin-tails with loose wavy tips.
  "M58 106 Q26 112 24 156 Q22 184 44 198 Q46 164 62 152 Q64 176 58 202 L82 192 L174 192 L198 202 Q192 176 194 152 Q210 164 212 198 Q234 184 232 156 Q230 112 198 106 Q192 38 128 32 Q64 38 58 106 Z",
  // Fluffy anime bob with flared tips.
  "M54 148 Q42 104 64 62 Q88 28 128 28 Q168 28 192 62 Q214 104 202 148 Q216 170 220 184 Q192 190 176 174 L80 174 Q64 190 36 184 Q40 170 54 148 Z",
  // Side ponytail + shoulder-length bob (Nijika-inspired silhouette).
  "M172 64 Q224 58 232 108 Q236 140 212 166 Q204 146 196 132 L192 176 L64 176 Q52 128 62 72 Q78 30 128 30 Q162 30 172 64 Z",
  // Long straight anime hair framing shoulders.
  "M50 224 Q48 134 62 70 Q80 28 128 26 Q176 28 194 70 Q208 134 206 224 L178 214 L168 186 L88 186 L78 214 Z",
  // Short layered wolf cut with playful spikes.
  "M56 154 Q40 132 52 96 Q48 64 78 44 Q102 22 134 26 Q174 26 194 56 Q216 86 204 128 Q214 152 194 166 L174 164 L82 164 L62 166 Z",
  // Soft wavy curls with single side braid silhouette.
  "M52 166 Q38 138 52 108 Q44 74 70 50 Q94 24 128 28 Q162 24 186 50 Q212 74 204 108 Q218 138 204 166 Q218 194 192 212 Q178 196 174 180 L82 180 Q70 202 52 216 Q42 192 52 166 Z",
];

const animeBangs = [
  // Wispy parted anime bangs.
  "M68 112 Q68 56 128 48 Q188 56 188 112 Q172 96 164 76 Q160 100 148 114 Q142 94 134 74 Q124 98 112 114 Q102 96 96 76 Q86 98 68 112 Z",
  // Straight-across blunt bangs with side locks.
  "M66 118 Q68 52 128 46 Q188 52 190 118 L174 108 L170 92 L162 106 L142 104 L136 86 L130 104 L110 104 L102 88 L96 106 L82 108 Z",
  // Side-swept swoop bangs with ahoge.
  "M124 34 Q134 10 152 16 Q138 24 134 46 Q186 52 190 114 Q168 102 152 72 Q144 98 118 112 Q98 96 94 78 Q84 104 68 118 Q66 56 124 34 Z",
  // Light center-parted fluffy bangs.
  "M68 116 Q70 52 128 48 Q186 52 188 116 Q168 106 154 84 Q144 104 132 106 L128 74 L124 106 Q112 104 102 84 Q88 106 68 116 Z",
];

const emblems = [
  "M-8 2 L-1 -6 L7 2 M-5 5 L2 -2 L8 4",
  "M-7 -4 Q-4 -7 0 -4 Q4 -7 8 -4 L8 5 Q4 2 0 5 Q-4 2 -7 5 Z M0 -4 L0 5",
  "M0 -8 Q1 -2 7 0 Q1 1 0 8 Q-1 1 -7 0 Q-1 -2 0 -8 Z",
  "M-3 -6 L-8 0 L-3 5 M3 -6 L8 0 L3 5",
  "M-7 -1 L-2 4 L7 -6",
  "M-7 4 L-3 -5 L1 4 L5 -5 L8 1",
];

export function drawInsignia(ctx: Brush, motif: number) {
  shape(ctx, emblems[motif % emblems.length]!, "", ink, 2);
}

function animeEye(
  ctx: Brush,
  x: number,
  y: number,
  mirror: boolean,
  accent: string,
  expressive: boolean,
  rng: Rng,
) {
  ctx.save();
  ctx.translate(x, y);
  if (mirror) ctx.scale(-1, 1);

  if (expressive) {
    // Classic Bocchi-style big starry wide-eyed anime reaction.
    shape(ctx, "M-14 2 Q-14 -14 0 -15 Q14 -14 14 2 Q14 13 0 14 Q-14 13 -14 2 Z", paper, ink, 1.8, rng);
    shape(ctx, "M-15 -3 Q-10 -16 1 -16 Q11 -16 14 -5 Q6 -12 -1 -12 Q-9 -12 -15 -3 Z", ink, ink, 1.2);
    shape(ctx, "M-9 0 Q-9 -10 0 -10 Q9 -10 9 0 Q9 10 0 10 Q-9 10 -9 0 Z", accent, ink, 1.2);
    shape(ctx, "M-5 0 Q-5 -6 0 -6 Q5 -6 5 0 Q5 6 0 6 Q-5 6 -5 0 Z", ink, "", 0);
    fourPointStar(ctx, 0, -0.5, 5.2, 6.0, "#ffffff");
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(-4.2, -5.0, 2.5, 0, Math.PI * 2);
    ctx.arc(3.8, 4.4, 1.5, 0, Math.PI * 2);
    ctx.fill();
    shape(ctx, "M-12 -19 Q-2 -26 11 -19", "", ink, 1.9, rng);
  } else {
    // Clean slice-of-life anime eye with glossy catchlights.
    shape(ctx, "M-13 1 Q-13 -12 0 -13 Q13 -12 13 1 Q12 11 0 12 Q-12 11 -13 1 Z", paper, "", 0);
    shape(ctx, "M-9 1 Q-9 -9 0 -9 Q9 -9 9 1 Q9 10 0 10 Q-9 10 -9 1 Z", accent, ink, 1.2);
    shape(ctx, "M-8 -4 Q0 -9 8 -4 Q5 2 0 2 Q-5 2 -8 -4 Z", ink, "", 0);
    shape(ctx, "M-15 -3 Q-10 -14 1 -14 Q11 -14 14 -3 Q6 -10 -1 -10 Q-9 -10 -15 -3 Z", ink, ink, 1.3, rng);
    shape(ctx, "M-9 11 Q0 13 9 11", "", ink, 1.2, rng);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(-3.5, -4, 3.1, 0, Math.PI * 2);
    ctx.arc(3.5, 4.2, 1.5, 0, Math.PI * 2);
    ctx.fill();
    shape(ctx, "M-11 -17 Q-1 -21 10 -17", "", ink, 1.6, rng);
  }
  ctx.restore();
}

function animeAccessory(ctx: Brush, style: number, accent: string, rng: Rng) {
  switch (style) {
    case 0:
      // Twin cube/bar clips (Bocchi nod).
      shape(ctx, "M162 72 L176 74 L175 81 L161 79 Z M165 83 L179 85 L178 92 L164 90 Z", accent, ink, 1.5, rng);
      break;
    case 1:
      // Cute round anime glasses.
      shape(ctx, "M84 123 Q84 109 100 109 Q116 109 116 123 Q116 137 100 137 Q84 137 84 123 Z", "", ink, 2.2, rng);
      shape(ctx, "M140 123 Q140 109 156 109 Q172 109 172 123 Q172 137 156 137 Q140 137 140 123 Z", "", ink, 2.2, rng);
      shape(ctx, "M116 122 Q128 118 140 122 M84 120 L74 116 M172 120 L182 116", "", ink, 1.8, rng);
      break;
    case 2:
      // Headphones around neck.
      shape(ctx, "M76 196 Q68 214 82 222 L92 212 Q86 202 88 192 Z", accent, ink, 2, rng);
      shape(ctx, "M180 196 Q188 214 174 222 L164 212 Q170 202 168 192 Z", accent, ink, 2, rng);
      break;
    case 3:
      // Crisp X hairclip on bangs (Kita nod).
      shape(ctx, "M76 80 L90 92 M90 80 L76 92", "", paper, 4.5);
      shape(ctx, "M76 80 L90 92 M90 80 L76 92", "", ink, 1.8, rng);
      break;
    case 4:
      // Cute beret.
      shape(ctx, "M66 64 Q60 32 118 22 Q178 18 192 52 Q144 42 74 66 Z", accent, ink, 2.2, rng);
      shape(ctx, "M118 22 L122 14", "", ink, 2.4, rng);
      break;
    default:
      // Ribbon bow at collar.
      shape(ctx, "M128 202 L112 194 L112 210 Z M128 202 L144 194 L144 210 Z", accent, ink, 1.8, rng);
      shape(ctx, "M124 198 L132 198 L132 206 L124 206 Z", paper, ink, 1.5, rng);
  }
}

export function drawCharacter(ctx: Brush, seed: number, motif: number, expressive: boolean) {
  const rng = createRng(seed ^ (expressive ? 0xa5a5a5a5 : 0x5a5a5a5a));
  const hairstyle = seed % backHairstyles.length;
  const accent = swatches[(seed >>> 6) % swatches.length]!;
  const hairPool = [accent, "#2b2530", "#f3c76b", "#ff9fc2", "#75bfff", "#f48872"];
  const hair = hairPool[(seed >>> 10) % hairPool.length]!;
  const skin = [paper, "#faecd8", "#f7e2cb"][(seed >>> 14) % 3]!;

  // Warm cream sketchbook paper base + Ben-Day halftone screentone dot gradient.
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 256, 256);
  halftoneField(ctx, accent, 8.5, 1.05, 3.05, false);

  ctx.save();
  if (expressive) {
    ctx.translate(128, 134);
    ctx.rotate(((seed & 1) ? 1 : -1) * 0.044);
    ctx.scale(1.045, 1.045);
    ctx.translate(-128, -134);
  }
  if (seed & 32) {
    ctx.translate(256, 0);
    ctx.scale(-1, 1);
  }

  // Back hair silhouette with double-pass sketchy ink stroke.
  shape(ctx, backHairstyles[hairstyle]!, hair, ink, 2.3, rng);

  // Neck + diagonal scribble pen shadow hatching + casual anime hoodie/collar shoulders.
  shape(ctx, "M114 162 L114 194 L142 194 L142 162 Z", skin, ink, 1.9, rng);
  shape(ctx, "M115 166 Q128 180 141 166 L141 176 Q128 186 115 176 Z", "#1d181b", "", 0);
  for (let hx = 117; hx <= 139; hx += 4.2) {
    wobblyLine(ctx, hx + 2, 174, hx - 2, 188, rng, 0.35, 0.9, ink, 0.35);
  }

  shape(
    ctx,
    "M42 256 Q48 206 86 196 L114 188 L128 208 L142 188 L170 196 Q208 206 214 256 Z",
    "#292329",
    ink,
    2.4,
    rng,
  );
  shape(ctx, "M108 188 L128 214 L148 188 L140 202 L128 220 L116 202 Z", paper, ink, 1.8, rng);
  // Diagonal scribble shading strokes along the collar lapels and hoodie folds.
  for (let i = 0; i < 5; i++) {
    const sx = 64 + i * 7;
    wobblyLine(ctx, sx + 5, 224, sx - 3, 248, rng, 0.5, 1.0, paper, 0.32);
    const rx = 164 + i * 7;
    wobblyLine(ctx, rx + 5, 224, rx - 3, 248, rng, 0.5, 1.0, paper, 0.32);
  }
  wobblyLine(ctx, 68, 256, 78, 212, rng, 0.8, 2.1, accent, 0.92);
  wobblyLine(ctx, 188, 256, 178, 212, rng, 0.8, 2.1, accent, 0.92);

  // Soft anime ears.
  shape(ctx, "M74 118 Q64 116 66 130 Q68 142 78 140 Z", skin, ink, 1.8, rng);
  shape(ctx, "M182 118 Q192 116 190 130 Q188 142 178 140 Z", skin, ink, 1.8, rng);

  // Rounded youthful anime face contour.
  shape(
    ctx,
    "M76 112 Q74 62 128 58 Q182 62 180 112 Q180 152 152 166 Q136 174 128 174 Q120 174 104 166 Q76 152 76 112 Z",
    skin,
    ink,
    2.2,
    rng,
  );

  // Soft pink blush glow + diagonal scribble cheek blush scratches (/////).
  ctx.save();
  ctx.fillStyle = "#ff769c";
  ctx.globalAlpha = expressive ? 0.28 : 0.14;
  ctx.beginPath();
  ctx.ellipse(94, 139, 13, 6.5, 0, 0, Math.PI * 2);
  ctx.ellipse(162, 139, 13, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const blushAlpha = expressive ? 0.88 : 0.48;
  for (let i = 0; i < 5; i++) {
    const lx = 83 + i * 4.4;
    wobblyLine(ctx, lx + 3.2, 135.5, lx, 142.2, rng, 0.35, 1.35, "#e65b84", blushAlpha);
    const rx = 152 + i * 4.4;
    wobblyLine(ctx, rx + 3.2, 135.5, rx, 142.2, rng, 0.35, 1.35, "#e65b84", blushAlpha);
  }

  // Large glossy anime eyes.
  animeEye(ctx, 100, 123, false, accent, expressive, rng);
  animeEye(ctx, 156, 123, true, accent, expressive, rng);

  // Minimalist anime tick nose.
  shape(ctx, "M128 135 L127 139", "", ink, 1.6);

  // Calm smile vs expressive Bocchi wavy cat / excited mouth.
  if (expressive) {
    shape(
      ctx,
      "M116 150 Q122 145 128 150 Q134 145 140 150 Q137 162 128 162 Q119 162 116 150 Z",
      "#f58ea0",
      ink,
      1.65,
      rng,
    );
  } else {
    shape(ctx, "M120 152 Q128 158 136 152", "", ink, 1.8, rng);
  }

  // Front bangs + cream highlight arc.
  const bang = animeBangs[(seed >>> 16) % animeBangs.length]!;
  shape(ctx, bang, hair, ink, 2.2, rng);
  shape(ctx, "M88 78 Q108 66 126 70 M138 70 Q156 68 170 80", "", paper, 1.65);

  // Signature accessory.
  animeAccessory(ctx, (seed >>> 19) % 6, accent, rng);

  // Subtle role badge at shoulder corner.
  ctx.save();
  ctx.translate(182, 224);
  shape(ctx, "M-13 -11 Q0 -15 13 -11 L13 8 Q0 15 -13 8 Z", paper, ink, 1.8, rng);
  drawInsignia(ctx, motif);
  ctx.restore();

  ctx.restore();

  // Expressive Bocchi manga tapered excitement wedges (\ | /) + sparkles in upper corner.
  if (expressive) {
    taperedWedge(ctx, 198, 56, 228, 38, 1.1, 3.6);
    taperedWedge(ctx, 202, 68, 236, 62, 1.1, 3.8);
    taperedWedge(ctx, 190, 44, 204, 18, 1.0, 3.3);
    fourPointStar(ctx, 34, 48, 7.5, 9.0, paper);
    fourPointStar(ctx, 34, 48, 5.2, 6.2, ink);
  }

  // Subtle ink halftone corner vignette + sketchy hand-drawn double-stroke ink frame.
  ctx.save();
  ctx.globalAlpha = 0.24;
  halftoneField(ctx, ink, 9, 0.7, 1.9, true);
  ctx.restore();
  drawSketchyFrame(ctx, rng);
}
