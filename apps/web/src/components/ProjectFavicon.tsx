import type { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import { useState } from "react";
import { useAssetUrl } from "../assets/assetUrls";
import { cn } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Map<string, string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
  /**
   * Project accent color. Tints the fallback icon directly; real favicon
   * images cannot be tinted, so they get a small corner badge instead.
   */
  accentColor?: string | null | undefined;
}) {
  const src = useAssetUrl(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
  });
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;
  const accentColor = input.accentColor ?? null;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FallbackIcon}
        accentColor={accentColor}
      />
    );
  }

  const cacheKey = getProjectFaviconCacheKey(input.environmentId, input.cwd, src);
  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
      accentColor={accentColor}
    />
  );
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
  accentColor,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  readonly accentColor?: string | null | undefined;
}) {
  return (
    <Icon
      className={cn("size-3.5 shrink-0 text-muted-foreground/50", className)}
      {...(accentColor ? { style: { color: accentColor } } : {})}
    />
  );
}

function ProjectFaviconImage({
  cacheKey,
  src,
  className,
  fallbackIcon: FallbackIcon,
  accentColor,
}: {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly accentColor: string | null;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedProjectFaviconSrcs.get(cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedProjectFaviconSrcs.get(cacheKey) === failedSrc) {
      loadedProjectFaviconSrcs.delete(cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  const image = displayedSrc ? (
    <img
      src={displayedSrc}
      alt=""
      className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
      onError={() => handleLoadError(displayedSrc)}
    />
  ) : null;

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback
          className={className}
          icon={FallbackIcon}
          accentColor={accentColor}
        />
      ) : null}
      {image && accentColor ? (
        <span className="relative inline-flex shrink-0">
          {image}
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-background"
            style={{ backgroundColor: accentColor }}
          />
        </span>
      ) : (
        image
      )}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            loadedProjectFaviconSrcs.set(cacheKey, src);
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
