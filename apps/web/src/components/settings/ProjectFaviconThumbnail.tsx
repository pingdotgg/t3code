import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { observeIntersection } from "~/lib/observeIntersection";

export function ProjectFaviconThumbnail(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly fallback: ReactNode;
  readonly path: string;
}) {
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const state = useAssetUrlState(
    props.environmentId,
    inView ? { _tag: "draft-workspace-file", cwd: props.cwd, path: props.path } : null,
  );
  const url = state._tag === "Success" ? state.url : null;

  const showImage = url !== null && failedUrl !== url;
  const imageLoaded = showImage && loadedUrl === url;

  return (
    <span
      // Asset URLs require a server request, so defer acquisition until the row is visible.
      ref={
        inView
          ? undefined
          : (node) => {
              if (!node) return;
              return observeIntersection(node, (entry) => {
                if (entry.isIntersecting) setInView(true);
              });
            }
      }
      className="relative flex size-8 shrink-0 items-center justify-center"
    >
      {!imageLoaded ? props.fallback : null}
      {showImage ? (
        <img
          key={url}
          alt=""
          className={`absolute max-h-8 max-w-8 rounded-sm object-contain${imageLoaded ? "" : " invisible"}`}
          decoding="async"
          loading="lazy"
          onError={() => setFailedUrl(url)}
          onLoad={() => setLoadedUrl(url)}
          src={url}
        />
      ) : null}
    </span>
  );
}
