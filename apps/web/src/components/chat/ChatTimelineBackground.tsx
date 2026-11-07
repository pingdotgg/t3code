import { useClientSettings } from "../../hooks/useSettings";

export function ChatTimelineBackground() {
  const image = useClientSettings((settings) => settings.timelineBackgroundImage);
  const opacity = useClientSettings((settings) => settings.timelineBackgroundOpacity);
  const blur = useClientSettings((settings) => settings.timelineBackgroundBlur);
  if (!image || opacity === 0) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        key={image}
        src={image}
        alt=""
        draggable={false}
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
        }}
        className="absolute inset-0 size-full object-cover"
        style={{ opacity: opacity / 100, filter: blur > 0 ? `blur(${blur}px)` : undefined }}
      />
    </div>
  );
}
