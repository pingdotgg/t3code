import { cn } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";

export const CHAT_BACKGROUND_TEXT_SHADOW_CLASSES =
  "[text-shadow:0_1px_3px_var(--background),0_0_1px_var(--background)] [&_.live-tool-shine]:[text-shadow:none] [&_.live-tool-shine]:drop-shadow-[0_1px_2px_var(--background)]";

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
