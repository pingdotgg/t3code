import { useLayoutEffect, useMemo, useRef } from "react";
import type { MarkdownImageOccurrence, MarkdownImageSource } from "react-native-enriched-markdown";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";

/**
 * Enriched asks about each image once and reads `resolveImageSource` like an
 * event handler, so a failed image would keep its placeholder until remount.
 * Our resolver fails while the environment is unreachable and is replaced when
 * that changes, so a failed image stays pending and asks the next resolver.
 */
export function useRetryingImageSource(resolve: MarkdownImageSourceResolver | undefined) {
  const latestRef = useRef(resolve);
  const retriesRef = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    latestRef.current = resolve;
    const retries = [...retriesRef.current];
    retriesRef.current.clear();
    for (const retry of retries) retry();
  }, [resolve]);

  const enabled = resolve !== undefined;
  return useMemo(() => {
    if (!enabled) return undefined;
    return (image: MarkdownImageOccurrence) =>
      new Promise<MarkdownImageSource | undefined>((settle) => {
        const request = { href: image.url, alt: image.altText || null, title: image.title || null };
        const attempt = () => {
          const current = latestRef.current;
          if (!current) return;
          Promise.resolve()
            .then(() => current(request))
            .then(
              (source) => settle(source ?? undefined),
              () => {
                if (latestRef.current !== current) attempt();
                else retriesRef.current.add(attempt);
              },
            );
        };
        attempt();
      });
  }, [enabled]);
}
