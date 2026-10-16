import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

// Each preview issues an asset URL over the socket, so wait until the row is on screen.
function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  // Without IntersectionObserver, load eagerly rather than never.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (inView || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setInView(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView]);
  return [ref, inView] as const;
}

export function ProjectFaviconThumbnail(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly fallback: ReactNode;
  readonly path: string;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const resource = useMemo(
    () =>
      inView ? ({ _tag: "draft-workspace-file", cwd: props.cwd, path: props.path } as const) : null,
    [inView, props.cwd, props.path],
  );
  const state = useAssetUrlState(props.environmentId, resource);
  const url = state._tag === "Success" ? state.url : null;

  return (
    <span ref={ref} className="flex size-8 shrink-0 items-center justify-center">
      {url && failedUrl !== url ? (
        <img
          alt=""
          className="max-h-8 max-w-8 rounded-sm object-contain"
          decoding="async"
          loading="lazy"
          onError={() => setFailedUrl(url)}
          src={url}
        />
      ) : (
        props.fallback
      )}
    </span>
  );
}
