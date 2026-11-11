import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  watchStaticFile,
  type CalculateMetadataFunction,
} from "remotion";
import {
  introTimeline,
  type CodeStep,
  type IntroJson,
  type IntroStep,
} from "../../shared/intro.ts";
import { VIDEO } from "../../shared/types.ts";
import { hand, sans } from "../fonts.ts";
import { Slide } from "../slides/Slide.tsx";
import { brand } from "../theme.ts";
import { ArchView } from "./Arch.tsx";
import { Board } from "./boards.tsx";
import { CodeSlide, SPLIT } from "./CodeSlide.tsx";
import { DashView } from "./Dash.tsx";
import { LinksView } from "./Links.tsx";
import { LoopView } from "./Loop.tsx";
import { BrowserPane, TerminalPane } from "./Panes.tsx";
import { PullRequestView } from "./PullRequest.tsx";
import { PyramidView } from "./Pyramid.tsx";
import { RollView } from "./Roll.tsx";

/** Width available to a step title (the frame minus its side margins). */
const TITLE_WIDTH = 1920 - 2 * 110;

export interface IntroProps extends Record<string, unknown> {
  intro?: IntroJson;
  /** The deck's folder under out/capture: `intro` or `loop`. */
  source?: string;
}

export const calculateIntroMetadata: CalculateMetadataFunction<IntroProps> = async ({ props }) => {
  const response = await fetch(staticFile(`${props.source ?? "intro"}/intro.json`));
  if (!response.ok) throw new Error("No intro build. Run `pnpm intro:build` first.");
  const intro = (await response.json()) as IntroJson;
  const total = intro.steps.reduce((sum, step) => sum + step.frames, 0);
  return { durationInFrames: Math.max(1, total), fps: VIDEO.fps, props: { ...props, intro } };
};

/** Same dark stage as the slides, without their headline layout. */
const Stage = () => (
  <AbsoluteFill
    style={{
      background: [
        `radial-gradient(900px 700px at 12% 18%, ${brand.moss}1c, transparent 65%)`,
        `radial-gradient(900px 700px at 88% 90%, ${brand.ember}18, transparent 65%)`,
        brand.bg,
      ].join(","),
    }}
  />
);

/** A thick hand-drawn arrow down the left edge, from a file to the one generated from it. */
const GeneratedArrow = ({ label, progress }: { label: string; progress: number }) => {
  const x = 160;
  const y1 = 530;
  const y2 = 600;
  const y = y1 + (y2 - y1) * progress;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      <g
        opacity={progress > 0 ? 1 : 0}
        stroke="#e0a86b"
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
      >
        <path d={`M ${x} ${y1} L ${x} ${y}`} />
        {progress >= 1 ? (
          <path d={`M ${x - 14} ${y2 - 18} L ${x} ${y2} L ${x + 14} ${y2 - 18}`} />
        ) : null}
      </g>
      <text
        x={x + 30}
        y={(y1 + y2) / 2 + 12}
        fontFamily={hand}
        fontWeight={700}
        fontSize={40}
        fill="#e0a86b"
        opacity={progress}
      >
        {label}
      </text>
    </svg>
  );
};

/** The most recent step of a kind before step `at`: maps pick up where they left off. */
const lastOf = <K extends IntroStep["kind"]>(steps: IntroStep[], at: number, kind: K) => {
  for (let i = at - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === kind) return s as Extract<IntroStep, { kind: K }>;
  }
  return undefined;
};

export const Intro = ({ intro }: IntroProps) => {
  const frame = useCurrentFrame();
  if (!intro) return null;
  const ranges = introTimeline(intro.steps);
  const index = Math.max(
    0,
    ranges.findIndex((r) => frame >= r.from && frame < r.to),
  );
  const at = index < 0 ? intro.steps.length - 1 : index;
  const step = intro.steps[at]!;
  const local = frame - ranges[at]!.from;
  const prev: IntroStep | undefined = intro.steps[at - 1];
  const prevCode = prev?.kind === "code" ? prev : undefined;
  const prev2Code =
    intro.steps[at - 2]?.kind === "code" ? (intro.steps[at - 2] as CodeStep) : undefined;

  if (step.kind === "slide") {
    return (
      <Slide
        layout={step.layout}
        props={{
          eyebrow: step.eyebrow,
          heading: step.heading,
          subtitle: step.subtitle,
          footer: step.footer,
        }}
      />
    );
  }
  // The caption stays put across steps that share it.
  // The step's title is the slide's heading; it changes with every step.
  const titleIn = prev && prev.title === step.title ? 1 : Math.min(1, local / 5);
  return (
    <AbsoluteFill>
      <Stage />
      {step.kind === "code" ? (
        <>
          <CodeSlide
            step={step}
            prev={prevCode}
            prev2={prev2Code}
            local={local}
            area={step.beside ? (step.under ? SPLIT.leftTop : SPLIT.left) : undefined}
          />
          {step.beside ? (
            <>
              <CodeSlide
                step={step.beside}
                prev={prevCode?.beside}
                prev2={prev2Code?.beside}
                local={local}
                area={SPLIT.right}
              />
              <LinksView
                step={step}
                prev={prevCode}
                left={step.under ? SPLIT.leftTop : SPLIT.left}
                right={SPLIT.right}
                local={local}
                delay={8}
              />
            </>
          ) : null}
          {step.under && step.beside ? (
            <>
              <CodeSlide
                step={step.under.step}
                prev={prevCode?.under?.step}
                local={local}
                area={SPLIT.leftBottom}
              />
              <GeneratedArrow
                label={step.under.label}
                progress={prevCode?.under ? 1 : Math.min(1, Math.max(0, (local - 2) / 8))}
              />
              <LinksView
                step={{ ...step.under.step, links: step.under.links, beside: step.beside }}
                prev={
                  prevCode?.under
                    ? {
                        ...prevCode.under.step,
                        links: prevCode.under.links,
                        beside: prevCode.beside,
                      }
                    : undefined
                }
                left={SPLIT.leftBottom}
                right={SPLIT.right}
                local={local}
                delay={14}
              />
            </>
          ) : null}
        </>
      ) : step.kind === "terminal" ? (
        <TerminalPane step={step} prev={prev} local={local} />
      ) : step.kind === "browser" ? (
        <BrowserPane step={step} prev={prev} local={local} />
      ) : step.kind === "loop" ? (
        <LoopView step={step} prev={lastOf(intro.steps, at, "loop")} local={local} />
      ) : step.kind === "dash" ? (
        <DashView step={step} prev={lastOf(intro.steps, at, "dash")} local={local} />
      ) : step.kind === "arch" ? (
        <ArchView step={step} local={local} />
      ) : step.kind === "roll" ? (
        <RollView step={step} prev={lastOf(intro.steps, at, "roll")} local={local} />
      ) : step.kind === "pyramid" ? (
        <PyramidView step={step} prev={lastOf(intro.steps, at, "pyramid")} local={local} />
      ) : step.kind === "comment" ? (
        <PullRequestView
          step={step}
          prev={prev?.kind === "comment" ? prev : undefined}
          local={local}
        />
      ) : (
        <Board board={step.board} stage={step.stage} local={local} />
      )}
      <div
        style={{
          position: "absolute",
          left: 110,
          right: 110,
          top: 44,
          fontFamily: sans,
          // One line always: a title too long for 52px shrinks just enough to fit.
          fontSize: Math.min(52, Math.floor(TITLE_WIDTH / (step.title.length * 0.54))),
          whiteSpace: "nowrap",
          fontWeight: 700,
          letterSpacing: -0.6,
          lineHeight: 1.15,
          color: brand.fg,
          opacity: titleIn,
          transform: `translateY(${(1 - titleIn) * 6}px)`,
        }}
      >
        {step.title}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Studio-only live preview: loads intro.json itself and reloads it whenever
 * `pnpm dev` rebuilds it, so edits to intro/steps.ts or a snippet show up
 * without restarting anything. Scrub or press → in the Studio timeline.
 */
export const IntroLive = () => {
  const [intro, setIntro] = useState<IntroJson>();
  const [handle] = useState(() => delayRender("loading intro.json"));
  useEffect(() => {
    const load = () =>
      fetch(`${staticFile("intro/intro.json")}?t=${Date.now()}`)
        .then((r) => r.json())
        .then((json: IntroJson) => {
          setIntro(json);
          continueRender(handle);
        });
    load();
    const watcher = watchStaticFile("intro/intro.json", () => load());
    return () => watcher.cancel();
  }, [handle]);
  return <Intro intro={intro} />;
};
