import { useEffect, useEffectEvent, useState } from "react";

/**
 * An image fetched from the environment (a capture, an asset preview), as a data URL. `key`
 * names what to show; a stale response for an older key is dropped.
 */
export function useLoadedImage(
  key: string | null,
  load: () => Promise<string | null>,
): string | null {
  const [image, setImage] = useState<{ key: string; src: string } | null>(null);
  const loadImage = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches image bytes from the environment when the requested image changes
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void loadImage().then((src) => {
      if (!cancelled && src !== null) setImage({ key, src });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return image !== null && image.key === key ? image.src : null;
}
