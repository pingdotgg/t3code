import { useSyncExternalStore, type CSSProperties } from "react";
import { cn } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";

let failedImage: string | null = null;
const imageListeners = new Set<() => void>();

function setFailedImage(image: string | null) {
  if (failedImage === image) return;
  failedImage = image;
  for (const listener of imageListeners) listener();
}

function subscribeToImage(listener: () => void) {
  imageListeners.add(listener);
  return () => imageListeners.delete(listener);
}

export function useTimelineBackgroundFailed(image: string) {
  return useSyncExternalStore(
    subscribeToImage,
    () => failedImage === image,
    () => false,
  );
}

export const CHAT_BACKGROUND_GLASS_SURFACE_CLASSES =
  "surface-glass [--surface-glass-color:var(--secondary)] [text-shadow:none] dark:[--surface-glass-color:color-mix(in_srgb,var(--input)_20%,var(--background))]";

export const CHAT_BACKGROUND_TEXT_SHADOW_CLASSES =
  "[text-shadow:var(--chat-text-shadow)] [--chat-blockquote-color:var(--contrast-foreground)] [--chat-link-color:color-mix(in_srgb,var(--info-foreground)_80%,var(--contrast-foreground))] [&_:is(button,[role=button],code,.chat-markdown-codeblock,.chat-markdown-file-link,.chat-markdown-artifact-template)]:[text-shadow:none]";

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
  if (!image || opacity === 0) return null;

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}
    >
      <img
        key={image}
        src={image}
        alt=""
        draggable={false}
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
          setFailedImage(image);
        }}
        onLoad={(event) => {
          event.currentTarget.style.visibility = "";
          if (failedImage === image) setFailedImage(null);
        }}
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
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const failed = useTimelineBackgroundFailed(image);
  return Boolean(image) && opacity > 0 && !failed;
}
