/**
 * Takumi template for Open Graph cards. Consumed only by the static
 * `og/[...slug].png.ts` endpoint at build time — never shipped to the
 * browser. The element tree is rendered directly to PNG by Takumi.
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
 * frontmatter. Fonts come from npm bundles, with variable Source Serif for
 * optical sizing and JetBrains Mono for programming ligatures.
 */

import type { ReactNode } from "react";
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
  darkHairline: "rgba(245,239,227,0.12)",
} as const;

export type OgCardKind = "marketing" | "doc" | "blog";

export interface OgCardProps {
  title: ReactNode;
  description?: ReactNode;
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

function DocCard({ title, description, eyebrow, kind }: OgCardProps) {
  const eyebrowText = (eyebrow ?? defaultEyebrow(kind ?? "doc")).toUpperCase();

  return (
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.bg,
        padding: "56px 64px",
        fontFamily: "'Source Serif 4'",
        color: COLORS.fg1,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <img
          src={yantraSvg({
            size: 96,
            theme: "light",
            output: "url",
          })}
          width={56}
          height={56}
          style={{ display: "flex" }}
        />
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 18,
            letterSpacing: 3,
            color: COLORS.accentDeep,
            fontWeight: 400,
          }}
        >
          {eyebrowText}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          marginTop: 56,
          fontFamily: "'Source Serif 4'",
          fontVariationSettings: "'opsz' 60",
          fontWeight: 500,
          fontSize: 110,
          lineHeight: 1.02,
          letterSpacing: -2,
          color: COLORS.fg1,
        }}
      >
        {title}
      </div>
      {description ? (
        <div
          style={{
            display: "flex",
            marginTop: 36,
            fontSize: 26,
            lineHeight: 1.45,
            color: COLORS.fg2,
            maxWidth: 980,
          }}
        >
          {description}
        </div>
      ) : null}
      <div style={{ display: "flex", flexGrow: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          borderTop: `1px solid ${COLORS.hairline}`,
          paddingTop: 24,
        }}
      >
        <div
          style={{
            fontFamily: "'Source Serif 4'",
            fontStyle: "italic",
            fontWeight: 400,
            fontSize: 32,
            color: COLORS.fg1,
          }}
        >
          alchemy
        </div>
        <div
          style={{
            fontFamily: "Caveat",
            fontWeight: 400,
            fontSize: 36,
            color: COLORS.accentDeep,
          }}
        >
          alchemy.run
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Blog variant — dark, dense, Bun-inspired release card.
// ────────────────────────────────────────────────────────────────────────────

function BlogCard({ title, description, date }: OgCardProps): any {
  return (
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.darkBg,
        padding: "72px 80px",
        fontFamily: "'Source Serif 4'",
        color: COLORS.darkFg1,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          fontFamily: "'Source Serif 4'",
          fontVariationSettings: "'opsz' 60",
          fontWeight: 500,
          fontSize: 84,
          lineHeight: 1.05,
          letterSpacing: -1.5,
          color: COLORS.darkFg1,
        }}
      >
        <span style={{ color: COLORS.darkAccent }}>{title}</span>
      </div>
      {description ? (
        <div
          style={{
            display: "flex",
            marginTop: 32,
            fontSize: 28,
            lineHeight: 1.5,
            color: COLORS.darkFg2,
            maxWidth: 1040,
          }}
        >
          {description}
        </div>
      ) : null}
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${COLORS.darkHairline}`,
          paddingTop: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontFamily: "'Source Serif 4'",
              fontSize: 24,
              color: COLORS.darkFg2,
            }}
          >
            {formatDate(date)}
          </div>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 16,
              letterSpacing: 3,
              color: COLORS.darkFg3,
            }}
          >
            ALCHEMY.RUN
          </div>
        </div>
        <img
          src={yantraSvg({ size: 96, theme: "dark", output: "url" })}
          width={72}
          height={72}
          style={{ display: "flex" }}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

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
