/**
 * Frames for the BUSY Bar alert intro. The device's own element timeouts only
 * resolve whole seconds, so motion is a list of draws the server sends on a
 * schedule. A redraw with an existing element id updates it in place, but an
 * element added mid-sequence draws on top for a frame before z-order applies,
 * so every element mounts hidden, in z-order, before anything moves.
 *
 * 1. Ignition: a hairline in the status color grows from the center point.
 * 2. Split: it parts into two edges that uncover the T3 mark between them.
 * 3. Glint: the edges fade while a soft light sweeps across the mark.
 * 4. Slide: the mark eases to the left edge, trailing two ghosts.
 * 5. Punch: the alert word zooms in big, stepping through the device fonts.
 * 6. Settle: it zooms down into the label slot while the title slides in
 *    from off the right edge.
 */

export const BUSY_BAR_WIDTH = 72;
export const BUSY_BAR_HEIGHT = 16;
export const LOGO_PATH = "logo.png";
export const LOGO_SIZE = 16;
// The mark's pixels inside the 16x16 asset.
const MARK_LEFT = 2;
const MARK_RIGHT = 14;
const CONTENT_X = LOGO_SIZE + 1;
const FRAME_MS = 50;

export interface BusyBarCard {
  readonly label: string;
  readonly color: string;
  readonly title: string;
  readonly timeoutSeconds: number;
}

type Element = Record<string, unknown> & { readonly id: string };

export interface BusyBarFrame {
  readonly atMs: number;
  readonly elements: ReadonlyArray<Element>;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const steps = (count: number) => Array.from({ length: count }, (_, i) => (i + 1) / count);
const lerp = (from: number, to: number, t: number) => Math.round(from + (to - from) * t);

/** `#RRGGBBAA` with its alpha scaled by `opacity` in [0, 1]. */
const withAlpha = (color: string, opacity: number) =>
  `${color.slice(0, 7)}${Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase()}`;

const rect = (
  id: string,
  x: number,
  width: number,
  color: string,
  z: number,
  y = 0,
  height = BUSY_BAR_HEIGHT,
): Element => ({
  id,
  type: "rectangle",
  x,
  y,
  width: Math.max(1, width),
  height: Math.max(1, height),
  fill: "solid",
  fill_colors: [color],
  border_width: 0,
  z_index: z,
});

const logo = (id: string, x: number, opacity: number, z: number): Element => ({
  id,
  type: "image",
  path: LOGO_PATH,
  x,
  y: 0,
  opacity: Math.round(opacity * 100),
  z_index: z,
});

const HIDDEN = "#00000000";
const BLACK = "#000000FF";

/** Elements the intro uses and the card does not; removed once the card is up. */
export const BUSY_BAR_TRANSIENT_IDS = [
  "edge-l",
  "edge-r",
  "mask-l",
  "mask-r",
  "glint-a",
  "glint-b",
  "ghost-1",
  "ghost-2",
];

const LOGO_Z = 4;

// Fonts from smallest to largest, with measured glyph advance and cap offset.
// `normal` and `large` are left out: their thin weight flickers mid-zoom.
const FONTS = [
  { font: "tiny", advance: 4.4, top: 1, height: 5 },
  { font: "small", advance: 4.6, top: 2, height: 5 },
  { font: "bold", advance: 6.75, top: 2, height: 7 },
  { font: "extra_large", advance: 8, top: 2, height: 10 },
] as const;
type Font = (typeof FONTS)[number];

const textWidth = (font: Font, text: string) => Math.round(font.advance * text.length) - 1;
const CONTENT_WIDTH = BUSY_BAR_WIDTH - CONTENT_X;

/** The biggest font the word fits in beside the mark. */
const punchFontIndex = (text: string) => {
  for (let index = FONTS.length - 1; index > 0; index--) {
    if (textWidth(FONTS[index]!, text) <= CONTENT_WIDTH - 2) return index;
  }
  return 0;
};

const labelElement = (
  card: BusyBarCard,
  font: Font,
  x: number,
  y: number,
  opacity = 1,
): Element => ({
  id: "label",
  type: "text",
  text: card.label,
  font: font.font,
  color: withAlpha(card.color, opacity),
  align: "top_left",
  x,
  y,
  z_index: 5,
});

const titleElement = (card: BusyBarCard, x: number, opacity = 1): Element => ({
  id: "title",
  type: "text",
  text: card.title,
  font: "small",
  color: withAlpha("#FFFFFFFF", opacity),
  align: "bottom_left",
  x,
  y: 15,
  width: BUSY_BAR_WIDTH - CONTENT_X,
  scroll_rate: 1500,
  scroll_start_delay: 1500,
  z_index: 5,
});

/** The settled card: mark at the left, status label over a scrolling title. */
export function busyBarCardElements(card: BusyBarCard): ReadonlyArray<Element> {
  return [
    logo("logo", 0, 1, LOGO_Z),
    labelElement(card, FONTS[0], CONTENT_X, 0),
    titleElement(card, CONTENT_X),
  ];
}

export function busyBarIntroFrames(card: BusyBarCard): ReadonlyArray<BusyBarFrame> {
  const color = card.color;
  const centerX = (BUSY_BAR_WIDTH - LOGO_SIZE) / 2;
  const mid = BUSY_BAR_WIDTH / 2;
  const half = (MARK_RIGHT - MARK_LEFT) / 2 + 1;
  const frames: Array<Omit<BusyBarFrame, "atMs">> = [];
  const hold = (count: number) => {
    for (let i = 0; i < count; i++) frames.push({ elements: [] });
  };

  // Mount everything hidden, lowest layer first. The masks start closed over the mark.
  frames.push({
    elements: [
      logo("ghost-2", centerX, 0, 2),
      logo("ghost-1", centerX, 0, 3),
      logo("logo", centerX, 0, LOGO_Z),
      labelElement(card, FONTS[0], CONTENT_X, 0, 0),
      titleElement(card, BUSY_BAR_WIDTH, 0),
      rect("mask-l", centerX, LOGO_SIZE / 2, BLACK, 20),
      rect("mask-r", mid, LOGO_SIZE / 2, BLACK, 20),
      rect("glint-a", 0, 1, HIDDEN, 25),
      rect("glint-b", 0, 1, HIDDEN, 25),
      rect("edge-l", mid, 1, HIDDEN, 30),
      rect("edge-r", mid, 1, HIDDEN, 30),
    ],
  });

  // 1. Ignition: the hairline grows out from the center point.
  steps(4).forEach((t, index) => {
    const height = lerp(2, BUSY_BAR_HEIGHT, easeOutCubic(t));
    frames.push({
      elements: [
        ...(index === 0 ? [logo("logo", centerX, 1, LOGO_Z)] : []),
        rect("edge-l", mid, 1, color, 30, (BUSY_BAR_HEIGHT - height) / 2, height),
      ],
    });
  });
  // 2. Split: two edges part and uncover the mark between them.
  for (const t of steps(7)) {
    const spread = lerp(0, half, easeOutCubic(t));
    const left = mid - spread;
    const right = mid + spread;
    frames.push({
      elements: [
        logo("logo", centerX, 1, 1),
        rect("mask-l", centerX, left - centerX, BLACK, 20),
        rect("mask-r", right, centerX + LOGO_SIZE - right, BLACK, 20),
        rect("edge-l", left - 1, 1, color, 30),
        rect("edge-r", right, 1, color, 30),
      ],
    });
  }

  // 3. Glint: edges fade out while a soft light crosses the mark.
  const glintFrames = 6;
  steps(glintFrames).forEach((t, index) => {
    const x = lerp(centerX - 2, centerX + LOGO_SIZE, easeInOutCubic(t));
    const fade = 1 - t;
    frames.push({
      elements: [
        ...(index === 0
          ? [rect("mask-l", centerX, 1, HIDDEN, 20), rect("mask-r", centerX, 1, HIDDEN, 20)]
          : []),
        rect("edge-l", mid - half - 1 - index, 1, withAlpha(color, fade), 30),
        rect("edge-r", mid + half + index, 1, withAlpha(color, fade), 30),
        {
          ...rect("glint-a", x - 2, 2, HIDDEN, 25),
          fill: "gradient_h",
          fill_colors: ["#FFFFFF00", "#FFFFFFB0"],
        },
        {
          ...rect("glint-b", x, 2, HIDDEN, 25),
          fill: "gradient_h",
          fill_colors: ["#FFFFFFB0", "#FFFFFF00"],
        },
      ],
    });
  });
  frames.push({
    elements: [
      rect("edge-l", 0, 1, HIDDEN, 30),
      rect("edge-r", 0, 1, HIDDEN, 30),
      rect("glint-a", 0, 1, HIDDEN, 25),
      rect("glint-b", 0, 1, HIDDEN, 25),
    ],
  });
  hold(4);

  // 4. Slide: the mark eases to the left edge with a fading trail.
  const slide = steps(10).map((t) => lerp(centerX, 0, easeInOutCubic(t)));
  slide.forEach((x, index) => {
    const behind1 = index >= 1 ? slide[index - 1]! : centerX;
    const behind2 = index >= 2 ? slide[index - 2]! : centerX;
    const settling = index === slide.length - 1;
    frames.push({
      elements: [
        logo("ghost-2", behind2, settling ? 0 : 0.15, 2),
        logo("ghost-1", behind1, settling ? 0 : 0.35, 3),
        logo("logo", x, 1, 4),
      ],
    });
  });
  frames.push({ elements: [logo("ghost-1", 0, 0, 3), logo("ghost-2", 0, 0, 2)] });
  hold(2);

  // 5. Punch: the word zooms in big, centered beside the mark.
  const peak = punchFontIndex(card.label);
  const centered = (font: Font) => ({
    x: CONTENT_X + Math.round((CONTENT_WIDTH - textWidth(font, card.label)) / 2),
    y: Math.round((BUSY_BAR_HEIGHT - font.height) / 2) - font.top,
  });
  const zoomIn = [Math.max(0, peak - 2), Math.max(0, peak - 1), peak];
  zoomIn.forEach((fontIndex, index) => {
    const font = FONTS[fontIndex]!;
    const at = centered(font);
    frames.push({ elements: [labelElement(card, font, at.x, at.y, (index + 1) / zoomIn.length)] });
  });
  hold(10);

  // 6. Settle: zoom down into the label slot, then the title slides in from the right.
  const zoomOut = Array.from({ length: peak + 1 }, (_, index) => peak - index);
  const from = centered(FONTS[peak]!);
  for (const t of steps(Math.max(zoomOut.length, 6))) {
    const eased = easeInOutCubic(t);
    const font = FONTS[zoomOut[Math.round(eased * (zoomOut.length - 1))]!]!;
    frames.push({
      elements: [labelElement(card, font, lerp(from.x, CONTENT_X, eased), lerp(from.y, 0, eased))],
    });
  }
  for (const t of steps(8)) {
    frames.push({
      elements: [titleElement(card, lerp(BUSY_BAR_WIDTH, CONTENT_X, easeOutCubic(t)))],
    });
  }

  return frames.map((frame, index) => ({ ...frame, atMs: index * FRAME_MS }));
}
