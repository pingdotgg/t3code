import type { EnvironmentId } from "@t3tools/contracts";
import {
  isProjectFaviconFallbackUrl,
  withProjectFaviconReloadParam,
} from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useState } from "react";
import { useAssetUrl } from "../assets/assetUrls";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const src = useAssetUrl(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
  });
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  return (
    <ProjectFaviconImage
      key={src}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
    />
  );
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={`size-3.5 shrink-0 text-muted-foreground/50 ${className ?? ""}`} />;
}

function ProjectFaviconImage({
  src,
  className,
  fallbackIcon: FallbackIcon,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );
  // Bumping the nonce re-fetches the favicon past the browser cache. The click
  // is not consumed here, so it still bubbles to the row (which opens the
  // thread) — pressing the icon both opens the thread and refreshes the icon.
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestReload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  // Reloading only swaps the query string, so React keeps the same <img>
  // element and the browser holds the loaded image on screen until the fresh
  // bytes arrive — no flash back to the fallback on every press.
  const displaySrc = withProjectFaviconReloadParam(src, reloadNonce);

  return (
    <>
      {status !== "loaded" ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      <img
        src={displaySrc}
        alt=""
        onClick={requestReload}
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
