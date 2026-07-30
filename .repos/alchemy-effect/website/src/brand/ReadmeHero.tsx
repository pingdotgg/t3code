/**
 * Satori template for the README hero — a tight stacked lockup of the
 * yantra mark above the italic "Alchemy" wordmark, centered on a
 * parchment ground. No frame, no tagline, no URL stamp. Rendered offline
 * by `scripts/generate-readme-hero.ts` to `images/readme-hero.png`.
 *
 * The native render size is 1200×720 (5:3). The README displays it at a
 * fixed badge width (~360px) so it reads as a brand mark, not a banner.
 */

import { yantraSvg } from "./yantra";

const COLORS = {
  bg: "#f5efe3",
  fg: "#2a2620",
  accent: "#3f5a2a",
} as const;

export const README_HERO_W = 1200;
export const README_HERO_H = 720;

export function ReadmeHero(): any {
  const yantra = yantraSvg({
    size: 280,
    stroke: COLORS.accent,
    dot: COLORS.accent,
    strokeWidth: 0.7,
  });
  const yantraDataUrl = `data:image/svg+xml;base64,${Buffer.from(yantra).toString("base64")}`;

  return {
    type: "div",
    key: null,
    props: {
      style: {
        width: README_HERO_W,
        height: README_HERO_H,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        backgroundColor: COLORS.bg,
        fontFamily: "Source Serif 4 Display",
        color: COLORS.fg,
      },
      children: [
        {
          type: "img",
          key: "yantra",
          props: {
            src: yantraDataUrl,
            width: 280,
            height: 280,
            style: { display: "flex" },
          },
        },
        {
          type: "div",
          key: "wm",
          props: {
            style: {
              display: "flex",
              fontFamily: "Source Serif 4 Display",
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 280,
              lineHeight: 1,
              letterSpacing: -4,
              color: COLORS.fg,
            },
            children: "Alchemy",
          },
        },
      ],
    },
  };
}
