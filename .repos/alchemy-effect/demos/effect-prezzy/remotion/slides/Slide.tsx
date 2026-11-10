import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { SlideItem } from "../../shared/types.ts";
import { mono, sans, serif } from "../fonts.ts";
import { AlchemyMark } from "../scene/Desktop.tsx";
import { brand } from "../theme.ts";

export type SlideProps = Pick<SlideItem, "layout" | "props">;

/** Fade + rise in, `delay` frames after the slide starts. */
const Enter = ({
  delay,
  children,
  style,
}: {
  delay: number;
  children: ReactNode;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
    durationInFrames: 24,
  });
  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${interpolate(progress, [0, 1], [28, 0])}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const Background = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 300], [0, 40]);
  return (
    <AbsoluteFill
      style={{
        background: [
          `radial-gradient(900px 700px at ${15 + drift / 8}% 20%, ${brand.moss}24, transparent 65%)`,
          `radial-gradient(900px 700px at ${85 - drift / 8}% 90%, ${brand.ember}1f, transparent 65%)`,
          brand.bg,
        ].join(","),
      }}
    >
      {/* Faint dot grid, like the website's hero. */}
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${brand.fg}14 1.2px, transparent 1.2px)`,
          backgroundSize: "36px 36px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />
    </AbsoluteFill>
  );
};

const Eyebrow = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: 26,
      letterSpacing: 6,
      textTransform: "uppercase",
      color: brand.moss,
    }}
  >
    {children}
  </div>
);

const TitleLayout = ({ props }: SlideProps) => (
  <AbsoluteFill style={{ justifyContent: "center", padding: "0 180px" }}>
    <Enter delay={0}>
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <AlchemyMark size={64} />
        {props.eyebrow ? <Eyebrow>{props.eyebrow}</Eyebrow> : null}
      </div>
    </Enter>
    <Enter delay={6}>
      <h1
        style={{
          margin: "44px 0 0",
          fontFamily: serif,
          fontWeight: 600,
          // A "\n" in the heading sets the lines exactly; sized so each fits on one.
          fontSize: props.heading.includes("\n") ? 118 : 132,
          lineHeight: 1.02,
          letterSpacing: -2,
          color: brand.fg,
          textWrap: "balance",
          whiteSpace: props.heading.includes("\n") ? "pre" : undefined,
        }}
      >
        {props.heading}
      </h1>
    </Enter>
    {props.subtitle ? (
      <Enter delay={14}>
        <p
          style={{
            margin: "36px 0 0",
            fontFamily: sans,
            fontSize: 40,
            color: brand.fgMuted,
            whiteSpace: "pre-line",
          }}
        >
          {props.subtitle}
        </p>
      </Enter>
    ) : null}
    {props.footer ? (
      <Enter delay={20} style={{ position: "absolute", left: 180, bottom: 96 }}>
        <div style={{ fontFamily: mono, fontSize: 34, letterSpacing: 1, color: brand.moss }}>
          {props.footer}
        </div>
      </Enter>
    ) : null}
  </AbsoluteFill>
);

const SectionLayout = ({ props }: SlideProps) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
    {props.eyebrow ? (
      <Enter delay={0}>
        <Eyebrow>{props.eyebrow}</Eyebrow>
      </Enter>
    ) : null}
    <Enter delay={5}>
      <h1
        style={{
          margin: "28px 0 0",
          fontFamily: serif,
          fontWeight: 600,
          fontSize: 104,
          color: brand.fg,
          maxWidth: 1600,
          textWrap: "balance",
        }}
      >
        {props.heading}
      </h1>
    </Enter>
    {props.subtitle ? (
      <Enter delay={12}>
        <p style={{ margin: "28px 0 0", fontFamily: sans, fontSize: 38, color: brand.fgMuted }}>
          {props.subtitle}
        </p>
      </Enter>
    ) : null}
  </AbsoluteFill>
);

const BulletsLayout = ({ props }: SlideProps) => (
  <AbsoluteFill style={{ justifyContent: "center", padding: "0 220px" }}>
    <Enter delay={0}>
      <h1 style={{ margin: 0, fontFamily: serif, fontWeight: 600, fontSize: 96, color: brand.fg }}>
        {props.heading}
      </h1>
    </Enter>
    <div style={{ marginTop: 64, display: "flex", flexDirection: "column", gap: 30 }}>
      {(props.bullets ?? []).map((bullet, i) => (
        <Enter key={bullet} delay={8 + i * 6}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 34 }}>
            <span style={{ fontFamily: mono, fontSize: 30, color: brand.moss }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span style={{ fontFamily: sans, fontSize: 52, color: brand.fg }}>{bullet}</span>
          </div>
        </Enter>
      ))}
    </div>
  </AbsoluteFill>
);

export const Slide = (slide: SlideProps & Record<string, unknown>) => (
  <AbsoluteFill>
    <Background />
    {slide.layout === "title" ? (
      <TitleLayout {...slide} />
    ) : slide.layout === "section" ? (
      <SectionLayout {...slide} />
    ) : (
      <BulletsLayout {...slide} />
    )}
  </AbsoluteFill>
);
