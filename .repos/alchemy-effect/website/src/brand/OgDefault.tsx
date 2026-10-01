import { YANTRA_THEMES, yantraSvg } from "./yantra";

export const OG_DEFAULT_W = 1200;
export const OG_DEFAULT_H = 630;

export function OgDefault() {
  const { stroke, bg } = YANTRA_THEMES.light;
  return (
    <div
      style={{
        width: OG_DEFAULT_W,
        height: OG_DEFAULT_H,
        position: "relative",
        background: bg,
        color: "#2a2620",
        fontFamily: "'Source Serif 4'",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 24,
          border: `1px solid ${stroke}`,
          opacity: 0.18,
        }}
      />
      <img
        src={yantraSvg({ size: 512, theme: "light", output: "url" })}
        width={260}
        height={260}
        style={{ position: "absolute", left: 470, top: 48 }}
      />
      <div
        style={{
          position: "absolute",
          top: 300,
          width: "100%",
          textAlign: "center",
          fontSize: 112,
          lineHeight: 1,
          fontStyle: "italic",
          fontWeight: 500,
          fontVariationSettings: "'opsz' 60",
          letterSpacing: -2,
        }}
      >
        Alchemy
      </div>
      <div
        style={{
          position: "absolute",
          top: 442,
          width: "100%",
          textAlign: "center",
          fontFamily: "'JetBrains Mono'",
          fontSize: 18,
          color: stroke,
          letterSpacing: 4,
        }}
      >
        {"ZERO -> PRODUCTION"}
      </div>
      <div
        style={{
          position: "absolute",
          top: 484,
          width: "100%",
          textAlign: "center",
          fontSize: 22,
          fontWeight: 600,
          color: "#85714f",
          letterSpacing: 0.5,
        }}
      >
        Infrastructure as Effects
      </div>
      <div
        style={{
          position: "absolute",
          right: 48,
          bottom: 48,
          fontFamily: "'JetBrains Mono'",
          fontSize: 18,
          color: "#85714f",
        }}
      >
        alchemy.run
      </div>
    </div>
  );
}
