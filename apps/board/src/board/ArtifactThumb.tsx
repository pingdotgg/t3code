import { useCallback, useState } from "react";

import { useArtifacts } from "../artifacts/ArtifactsContext";
import { useArtifactImageUrl } from "../state/artifacts";
import type { Artifact } from "../store/artifacts";

export const THUMB = "size-7 shrink-0 rounded";

/** The thumbnail of an image. Its URL is minted only once the card has been on screen. */
export function ArtifactThumb({ artifact }: { artifact: Artifact }) {
  const { environmentId, mediaThreadId } = useArtifacts();
  const [seen, setSeen] = useState(false);
  const watch = useCallback((element: HTMLSpanElement) => {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setSeen(true);
      observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const url = useArtifactImageUrl(
    environmentId,
    mediaThreadId,
    seen ? artifact.absolutePath : null,
  );
  return (
    <span ref={watch} className="shrink-0">
      {url._tag === "Success" ? (
        <img
          src={url.url}
          alt=""
          loading="lazy"
          decoding="async"
          className={`block ${THUMB} object-cover`}
        />
      ) : (
        <span className={`block ${THUMB} bg-hover`} aria-hidden />
      )}
    </span>
  );
}
