import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { TITLE_BAR, WINDOW, type AppId } from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { brand } from "../theme.ts";

export const APP_NAMES: Record<AppId, string> = {
  editor: "Code",
  terminal: "Ghostty",
  diagram: "Architecture",
  browser: "Google Chrome",
  slide: "",
};

/** Dark wallpaper with the brand's moss and ember glows. */
export const Wallpaper = () => (
  <AbsoluteFill
    style={{
      background: [
        `radial-gradient(1200px 800px at 12% 18%, ${brand.moss}33, transparent 60%)`,
        `radial-gradient(1000px 700px at 88% 85%, ${brand.ember}2e, transparent 60%)`,
        `linear-gradient(160deg, #1b1712, ${brand.bg} 55%, #0d0b08)`,
      ].join(","),
    }}
  />
);

export const MenuBar = ({ app }: { app: AppId }) => (
  <div
    style={{
      position: "absolute",
      inset: "0 0 auto 0",
      height: 34,
      display: "flex",
      alignItems: "center",
      gap: 26,
      padding: "0 22px",
      background: "rgba(20, 17, 13, 0.55)",
      backdropFilter: "blur(20px)",
      color: "#f2ede2",
      fontFamily: sans,
      fontSize: 15,
    }}
  >
    <AlchemyMark size={18} />
    <span style={{ fontWeight: 700 }}>{APP_NAMES[app]}</span>
    {["File", "Edit", "View", "Window", "Help"].map((item) => (
      <span key={item} style={{ opacity: 0.85 }}>
        {item}
      </span>
    ))}
    <span style={{ marginLeft: "auto", opacity: 0.85 }}>Tue 9:41 AM</span>
  </div>
);

export const AlchemyMark = ({ size, style }: { size: number; style?: CSSProperties }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={brand.moss}
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 21.225 L4.0109 7.3875 L19.9891 7.3875 Z" />
    <circle cx="12" cy="12" r="1.3" fill={brand.ember} stroke="none" />
  </svg>
);

const TrafficLights = () => (
  <div style={{ display: "flex", gap: 9 }}>
    {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
      <div key={color} style={{ width: 13, height: 13, borderRadius: 7, background: color }} />
    ))}
  </div>
);

/** A macOS window at the shared window frame. `bar` replaces the default title bar (browser tabs). */
export const Window = ({
  title,
  background,
  bar,
  style,
  children,
}: {
  title?: string;
  background: string;
  bar?: ReactNode;
  style?: CSSProperties;
  children: ReactNode;
}) => (
  <div
    style={{
      position: "absolute",
      left: WINDOW.x,
      top: WINDOW.y,
      width: WINDOW.width,
      height: WINDOW.height,
      borderRadius: 12,
      overflow: "hidden",
      background,
      boxShadow:
        "0 0 0 1px rgba(255,255,255,0.09), 0 30px 80px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    {bar ?? (
      <div
        style={{
          height: TITLE_BAR,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          position: "relative",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <TrafficLights />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#a0a0a0",
            fontFamily: sans,
            fontSize: 14,
            fontWeight: 500,
            pointerEvents: "none",
          }}
        >
          {title}
        </div>
      </div>
    )}
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>{children}</div>
  </div>
);

export { TrafficLights };
