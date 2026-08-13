import { useEffect, useRef } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { subscribeGlyphClock } from "./clock.ts";
import {
  BAR_PIVOT_X,
  BAR_PIVOT_Y,
  GLYPH_CX,
  GLYPH_CY,
  GLYPH_POSES,
  GLYPH_VIEWBOX,
  THREE_PATH,
  THREE_PIVOT_X,
  THREE_PIVOT_Y,
  T_BAR_PATH,
  T_PIVOT_X,
  T_PIVOT_Y,
  T_STEM_PATH,
  clonePose,
  flutterOffset,
  glyphStatusLabel,
  isLiveGlyphStatus,
  lerpPose,
  poseDistance,
  type AgentGlyphStatus,
  type GlyphPose,
} from "./poses.ts";

const SETTLE_EPSILON = 0.08;
const LERP_RATE = 14;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type AgentGlyphProps = {
  status: AgentGlyphStatus;
  sessionRunning: boolean;
  className?: string;
};

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION_QUERY).matches;
}

function groupTransform(pose: GlyphPose, flutterY: number, flutterScale: number): string {
  const scale = pose.groupScale * flutterScale;
  return `translate(${GLYPH_CX + pose.groupX} ${GLYPH_CY + pose.groupY + flutterY}) rotate(${pose.groupRotate}) scale(${scale}) translate(${-GLYPH_CX} ${-GLYPH_CY})`;
}

function around(x: number, y: number, rotate: number, scaleX = 1, scaleY = 1): string {
  return `translate(${x} ${y}) rotate(${rotate}) scale(${scaleX} ${scaleY}) translate(${-x} ${-y})`;
}

function paintPose(
  nodes: {
    group: SVGGElement;
    tee: SVGGElement;
    bar: SVGPathElement;
    three: SVGPathElement;
    eye: SVGEllipseElement;
  },
  pose: GlyphPose,
  flutterY: number,
  flutterScale: number,
): void {
  nodes.group.setAttribute("transform", groupTransform(pose, flutterY, flutterScale));
  nodes.tee.setAttribute("transform", around(T_PIVOT_X, T_PIVOT_Y, pose.tRotate));
  nodes.bar.setAttribute("transform", around(BAR_PIVOT_X, BAR_PIVOT_Y, pose.barRotate));
  nodes.three.setAttribute(
    "transform",
    around(THREE_PIVOT_X, THREE_PIVOT_Y, pose.threeRotate, pose.threeScaleX, pose.threeScaleY),
  );
  nodes.eye.setAttribute("cx", String(pose.eyeCx));
  nodes.eye.setAttribute("cy", String(pose.eyeCy));
  nodes.eye.setAttribute("rx", String(pose.eyeRx));
  nodes.eye.setAttribute("ry", String(pose.eyeRy));
  nodes.eye.setAttribute("opacity", String(pose.eyeOpacity));
}

function targetPose(status: AgentGlyphStatus, playDone: boolean): GlyphPose {
  if (playDone) return GLYPH_POSES.done;
  return GLYPH_POSES[status];
}

export function AgentGlyph({ status, sessionRunning, className }: AgentGlyphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const teeRef = useRef<SVGGElement>(null);
  const barRef = useRef<SVGPathElement>(null);
  const threeRef = useRef<SVGPathElement>(null);
  const eyeRef = useRef<SVGEllipseElement>(null);
  const currentRef = useRef(clonePose(GLYPH_POSES[status]));
  const statusRef = useRef(status);
  const sessionRunningRef = useRef(sessionRunning);
  const playDoneRef = useRef(false);
  const lastNowRef = useRef<number | null>(null);
  const kickRef = useRef(() => {});

  sessionRunningRef.current = sessionRunning;

  useEffect(() => {
    const svg = svgRef.current;
    const group = groupRef.current;
    const tee = teeRef.current;
    const bar = barRef.current;
    const three = threeRef.current;
    const eye = eyeRef.current;
    if (!svg || !group || !tee || !bar || !three || !eye) return;

    const nodes = { group, tee, bar, three, eye };
    let visible = true;
    let hidden = typeof document !== "undefined" && document.hidden;
    let reduced = prefersReducedMotion();
    let unsubscribeClock: (() => void) | null = null;

    const syncClock = () => {
      const pose = currentRef.current;
      const target = targetPose(statusRef.current, playDoneRef.current);
      const fluttering =
        sessionRunningRef.current && !reduced && target.flutterAmp > 0 && pose.flutterAmp > 0.02;
      const settling = poseDistance(pose, target) > SETTLE_EPSILON;
      const shouldTick =
        !reduced && visible && !hidden && (fluttering || settling || playDoneRef.current);

      if (shouldTick) {
        if (!unsubscribeClock) {
          lastNowRef.current = null;
          unsubscribeClock = subscribeGlyphClock(onTick);
        }
        return;
      }

      if (unsubscribeClock) {
        unsubscribeClock();
        unsubscribeClock = null;
      }
      lastNowRef.current = null;
      const still = targetPose(statusRef.current, false);
      if (reduced) {
        currentRef.current = clonePose(still);
      }
      paintPose(nodes, currentRef.current, 0, 1);
    };

    const onTick = (nowMs: number) => {
      const last = lastNowRef.current;
      lastNowRef.current = nowMs;
      const dt = last === null ? 1 / 60 : Math.min(0.05, Math.max(0, (nowMs - last) / 1000));
      const target = targetPose(statusRef.current, playDoneRef.current);
      const t = 1 - Math.exp(-LERP_RATE * dt);
      const next = lerpPose(currentRef.current, target, t);
      currentRef.current = next;

      if (playDoneRef.current && poseDistance(next, GLYPH_POSES.done) < SETTLE_EPSILON) {
        playDoneRef.current = false;
      }

      const flutterAmp = sessionRunningRef.current ? next.flutterAmp : 0;
      const flutter = flutterOffset(nowMs, flutterAmp, next.flutterSpeed);
      paintPose(nodes, next, flutter.y, flutter.scale);
      if (
        poseDistance(next, targetPose(statusRef.current, playDoneRef.current)) <= SETTLE_EPSILON
      ) {
        syncClock();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        syncClock();
      },
      { threshold: 0 },
    );
    observer.observe(svg);

    const onVisibility = () => {
      hidden = document.hidden;
      syncClock();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const media = typeof matchMedia === "function" ? matchMedia(REDUCED_MOTION_QUERY) : null;
    const onMotion = () => {
      reduced = prefersReducedMotion();
      if (reduced) playDoneRef.current = false;
      syncClock();
    };
    media?.addEventListener("change", onMotion);

    paintPose(nodes, currentRef.current, 0, 1);
    kickRef.current = syncClock;
    syncClock();

    return () => {
      kickRef.current = () => {};
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      media?.removeEventListener("change", onMotion);
      unsubscribeClock?.();
    };
  }, []);

  useEffect(() => {
    const previous = statusRef.current;
    if (status === "idle" && isLiveGlyphStatus(previous) && !prefersReducedMotion()) {
      playDoneRef.current = true;
    }
    if (status !== "idle") {
      playDoneRef.current = false;
    }
    statusRef.current = status;

    const svg = svgRef.current;
    const group = groupRef.current;
    const tee = teeRef.current;
    const bar = barRef.current;
    const three = threeRef.current;
    const eye = eyeRef.current;
    if (!svg || !group || !tee || !bar || !three || !eye) return;
    if (prefersReducedMotion()) {
      currentRef.current = clonePose(GLYPH_POSES[status]);
      paintPose({ group, tee, bar, three, eye }, currentRef.current, 0, 1);
    }
    kickRef.current();
  }, [status, sessionRunning]);

  const label = glyphStatusLabel(status);
  const mark = (
    <svg
      ref={svgRef}
      viewBox={GLYPH_VIEWBOX}
      width="28"
      height="28"
      role="img"
      aria-label={label}
      className={cn("size-7 shrink-0", className)}
    >
      <g ref={groupRef} fill="currentColor">
        <g ref={teeRef}>
          <path d={T_STEM_PATH} />
          <path ref={barRef} d={T_BAR_PATH} />
        </g>
        <path ref={threeRef} d={THREE_PATH} />
        <ellipse ref={eyeRef} fill="var(--background, Canvas)" />
      </g>
    </svg>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center",
              status === "debug"
                ? "text-destructive"
                : status === "idle" || status === "review"
                  ? "text-muted-foreground"
                  : "text-foreground",
            )}
          />
        }
      >
        {mark}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
