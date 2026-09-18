import { YANTRA_THEMES, yantraSvg } from "./yantra";

export const README_HERO_W = 1200;
export const README_HERO_H = 720;

export function ReadmeHero() {
  return (
    <div
      style={{
        width: README_HERO_W,
        height: README_HERO_H,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        backgroundColor: YANTRA_THEMES.light.bg,
        fontFamily: "'Source Serif 4'",
        color: "#2a2620",
      }}
    >
      <img
        src={yantraSvg({ size: 280, output: "url" })}
        width={280}
        height={280}
      />
      <div
        style={{
          fontStyle: "italic",
          fontWeight: 600,
          fontVariationSettings: "'opsz' 60",
          fontSize: 270,
          lineHeight: 1,
          letterSpacing: -4,
        }}
      >
        Alchemy
      </div>
    </div>
  );
}
