/**
 * Satori template for Open Graph cards. Consumed only by the static
 * `og/[...slug].png.ts` endpoint at build time — never shipped to the
 * browser. The JSX is interpreted by satori, which supports a Flexbox
 * subset and inline `style` props (no CSS classes).
 *
 * Two visual variants:
 *
 *   - `doc` / `marketing` — parchment background, serif headline, the
 *     yantra glyph + eyebrow up top, hand-drawn "alchemy.run" caption
 *     bottom-right. Mirrors the homepage hero.
 *
 *   - `blog` — dark variant inspired by Bun's release-note cards. Title
 *     anchored top-left, dense multi-line description filling the body,
 *     publish date + yantra mark in the footer. Designed to look full
 *     and editorial; relies on posts having a meaty `description`/
 *     `excerpt` in frontmatter.
 *
 * Title and description are rendered verbatim from the source page's
 * frontmatter — no splitting, truncation, or glyph workarounds. The
 * full unsubsetted variable TTFs loaded by the endpoint cover every
 * Unicode codepoint we use.
 */

import { yantraSvg } from "./yantra";

const COLORS = {
  bg: "#f5efe3",
  fg1: "#2a2620",
  fg2: "#4e402c",
  fg3: "#85714f",
  accent: "#5c7a3e",
  accentDeep: "#3f5a2a",
  hairline: "rgba(42,38,32,0.14)",
  // Blog (dark) palette.
  darkBg: "#161310",
  darkFg1: "#f5efe3",
  darkFg2: "#bdb09a",
  darkFg3: "#7d705c",
  darkAccent: "#a8c47a",
  // Dark-mode yantra — lifted moss stroke + terracotta bindu dot, mirroring
  // the runtime tokens (--alc-accent / --alc-yantra-dot in the .dark block).
  darkYantraStroke: "#7a9a5e",
  darkYantraDot: "#c56e3c",
  darkHairline: "rgba(245,239,227,0.12)",
} as const;

export type OgCardKind = "marketing" | "doc" | "blog";

/**
 * One styled segment of a structured title — mirrors the way the
 * homepage hero declares its own emphasis with explicit `<span>` markup.
 * Pages that want the accent treatment supply an array; doc pages pass
 * a plain string and get plain text.
 */
export interface TitlePart {
  text: string;
  italic?: boolean;
  /** Render this part in the deep-moss accent color. */
  accent?: boolean;
  /**
   * Override the font family for this part. Use `"tinos"` for glyphs
   * that should render from the TNR-equivalent face (the marketing
   * arrow `→` — mirrors the website's font stack falling through to
   * Times New Roman for U+2192). Default: Source Serif 4 Display.
   */
  font?: "tinos";
}

export interface OgCardProps {
  title: string | TitlePart[];
  description?: string;
  /** Drives the eyebrow label (e.g. "guide", "concept", "blog"). */
  eyebrow?: string;
  kind?: OgCardKind;
  /** ISO date string (YYYY-MM-DD). Rendered in the blog footer. */
  date?: string;
}

const W = 1200;
const H = 630;

export function OgCard(props: OgCardProps): any {
  const kind = props.kind ?? "doc";
  if (kind === "blog") return BlogCard(props);
  return DocCard(props);
}

// ────────────────────────────────────────────────────────────────────────────
// Doc / marketing variant — parchment hero.
// ────────────────────────────────────────────────────────────────────────────

function DocCard({ title, description, eyebrow, kind }: OgCardProps): any {
  const eyebrowText = (eyebrow ?? defaultEyebrow(kind ?? "doc")).toUpperCase();
  const yantraDataUrl = yantraImage(COLORS.accentDeep);

  return {
    type: "div",
    key: null,
    props: {
      style: {
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.bg,
        padding: "56px 64px",
        fontFamily: "Source Serif 4",
        color: COLORS.fg1,
        position: "relative",
      },
      children: [
        // Eyebrow row — yantra mark + monospace label.
        {
          type: "div",
          key: "top",
          props: {
            style: { display: "flex", alignItems: "center", gap: 18 },
            children: [
              {
                type: "img",
                key: "y",
                props: {
                  src: yantraDataUrl,
                  width: 56,
                  height: 56,
                  style: { display: "flex" },
                },
              },
              {
                type: "div",
                key: "eb",
                props: {
                  style: {
                    fontFamily: "JetBrains Mono",
                    fontSize: 18,
                    letterSpacing: 3,
                    color: COLORS.accentDeep,
                    fontWeight: 400,
                  },
                  children: eyebrowText,
                },
              },
            ],
          },
        },
        // Title.
        {
          type: "div",
          key: "title",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              marginTop: 56,
              fontFamily: "Source Serif 4 Display",
              fontWeight: 600,
              fontSize: 110,
              lineHeight: 1.02,
              letterSpacing: -2,
              color: COLORS.fg1,
            },
            children: renderTitle(title, COLORS.fg1, COLORS.accentDeep),
          },
        },
        description
          ? {
              type: "div",
              key: "desc",
              props: {
                style: {
                  display: "flex",
                  marginTop: 36,
                  fontSize: 26,
                  lineHeight: 1.45,
                  color: COLORS.fg2,
                  maxWidth: 980,
                },
                children: description,
              },
            }
          : null,
        // Spacer pushes the footer to the bottom.
        {
          type: "div",
          key: "spacer",
          props: { style: { display: "flex", flexGrow: 1 } },
        },
        // Footer — hairline + wordmark + hand-drawn URL.
        {
          type: "div",
          key: "footer",
          props: {
            style: {
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              borderTop: `1px solid ${COLORS.hairline}`,
              paddingTop: 24,
            },
            children: [
              {
                type: "div",
                key: "wm",
                props: {
                  style: {
                    fontFamily: "Source Serif 4",
                    fontStyle: "italic",
                    fontWeight: 400,
                    fontSize: 32,
                    color: COLORS.fg1,
                  },
                  children: "alchemy",
                },
              },
              {
                type: "div",
                key: "url",
                props: {
                  style: {
                    fontFamily: "Caveat",
                    fontWeight: 400,
                    fontSize: 36,
                    color: COLORS.accentDeep,
                  },
                  children: "alchemy.run",
                },
              },
            ],
          },
        },
      ].filter(Boolean),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Blog variant — dark, dense, Bun-inspired release card.
// ────────────────────────────────────────────────────────────────────────────

function BlogCard({ title, description, date }: OgCardProps): any {
  const yantraDataUrl = yantraImage(
    COLORS.darkYantraStroke,
    COLORS.darkYantraDot,
  );

  return {
    type: "div",
    key: null,
    props: {
      style: {
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.darkBg,
        padding: "72px 80px",
        fontFamily: "Source Serif 4",
        color: COLORS.darkFg1,
      },
      children: [
        // Title — large, top-anchored. Plain string for blog posts.
        {
          type: "div",
          key: "title",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap",
              fontFamily: "Source Serif 4 Display",
              fontWeight: 600,
              fontSize: 84,
              lineHeight: 1.05,
              letterSpacing: -1.5,
              color: COLORS.darkFg1,
            },
            children: renderTitle(title, COLORS.darkFg1, COLORS.darkAccent),
          },
        },
        // Description — fills the body. Larger maxWidth than doc cards
        // so multi-sentence excerpts wrap to 4–6 lines.
        description
          ? {
              type: "div",
              key: "desc",
              props: {
                style: {
                  display: "flex",
                  marginTop: 32,
                  fontSize: 28,
                  lineHeight: 1.5,
                  color: COLORS.darkFg2,
                  maxWidth: 1040,
                },
                children: description,
              },
            }
          : null,
        // Spacer pushes the footer to the bottom.
        {
          type: "div",
          key: "spacer",
          props: { style: { display: "flex", flexGrow: 1 } },
        },
        // Footer — date on the left, yantra mark on the right.
        {
          type: "div",
          key: "footer",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: `1px solid ${COLORS.darkHairline}`,
              paddingTop: 28,
            },
            children: [
              {
                type: "div",
                key: "date",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  },
                  children: [
                    {
                      type: "div",
                      key: "d",
                      props: {
                        style: {
                          fontFamily: "Source Serif 4",
                          fontSize: 24,
                          color: COLORS.darkFg2,
                        },
                        children: formatDate(date),
                      },
                    },
                    {
                      type: "div",
                      key: "wm",
                      props: {
                        style: {
                          fontFamily: "JetBrains Mono",
                          fontSize: 16,
                          letterSpacing: 3,
                          color: COLORS.darkFg3,
                        },
                        children: "ALCHEMY.RUN",
                      },
                    },
                  ],
                },
              },
              {
                type: "img",
                key: "y",
                props: {
                  src: yantraDataUrl,
                  width: 72,
                  height: 72,
                  style: { display: "flex" },
                },
              },
            ],
          },
        },
      ].filter(Boolean),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function yantraImage(stroke: string, dot: string = stroke): string {
  const svg = yantraSvg({
    size: 96,
    stroke,
    dot,
    strokeWidth: 0.7,
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderTitle(
  title: string | TitlePart[],
  fg: string,
  accent: string,
): any {
  if (!Array.isArray(title)) return title;
  return title.map((part, i) => ({
    type: "span",
    key: `tp${i}`,
    props: {
      style: {
        fontFamily: part.font === "tinos" ? "Tinos" : "Source Serif 4 Display",
        fontStyle: part.italic ? "italic" : "normal",
        color: part.accent ? accent : fg,
        fontWeight: part.font === "tinos" ? 400 : 600,
      },
      children: part.text,
    },
  }));
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  // Parse YYYY-MM-DD without timezone surprises.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function defaultEyebrow(kind: OgCardKind): string {
  switch (kind) {
    case "marketing":
      return "alchemy · zero to production";
    case "blog":
      return "blog · alchemy.run";
    case "doc":
    default:
      return "alchemy · documentation";
  }
}
