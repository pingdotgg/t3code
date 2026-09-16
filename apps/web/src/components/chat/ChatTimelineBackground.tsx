import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";

export const CHAT_BACKGROUND_GLASS_SURFACE_CLASSES =
  "surface-glass [--surface-glass-color:var(--secondary)] [text-shadow:none] dark:[--surface-glass-color:color-mix(in_srgb,var(--input)_20%,var(--background))]";

export const CHAT_BACKGROUND_TEXT_SHADOW_CLASSES =
  "[text-shadow:var(--chat-text-shadow)] [&_:is(button,[role=button],code,.chat-markdown-codeblock,.chat-markdown-file-link,.chat-markdown-artifact-template)]:[text-shadow:none]";

export function timelineTextShadowStyle(opacity: number, blur: number): CSSProperties {
  return {
    "--chat-text-shadow":
      opacity === 0
        ? "none"
        : `0 1px ${blur}px color-mix(in oklab, var(--background) ${opacity}%, transparent)`,
  } as CSSProperties;
}

export function useTimelineTextShadowStyle() {
  const opacity = useClientSettings((settings) => settings.timelineTextShadowOpacity);
  const blur = useClientSettings((settings) => settings.timelineTextShadowBlur);
  return timelineTextShadowStyle(opacity, blur);
}

export function TimelineBackgroundImage({
  image,
  opacity,
  blur,
  className,
}: {
  image: string;
  opacity: number;
  blur: number;
  className?: string | undefined;
}) {
  if (!image) return null;

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}
    >
      <img
        src={image}
        alt=""
        draggable={false}
        className="absolute inset-0 size-full object-cover"
        style={{
          opacity: opacity / 100,
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
        }}
      />
    </div>
  );
}

export function ChatTimelineBackground({ className }: { className?: string | undefined }) {
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);
  return (
    <TimelineBackgroundImage image={image} opacity={opacity} blur={blur} className={className} />
  );
}

/** Timeline cards only pay for backdrop blur when there is a wallpaper to show through. */
export function useHasTimelineBackground() {
  return useClientSettings((settings) => Boolean(settings.timelineBackgroundImage));
}
