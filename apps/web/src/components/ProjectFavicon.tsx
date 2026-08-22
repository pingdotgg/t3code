import { useAtomValue } from "@effect/atom-react";
import {
  forgetProjectFavicon,
  getLoadedProjectFavicon,
  rememberProjectFavicon,
  subscribeProjectFavicons,
} from "@t3tools/client-runtime/state/project-favicon";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { derivePhysicalProjectKeyFromPath } from "../logicalProject";
import { projectFaviconSourcesAtom } from "../state/projects";
import { cn } from "~/lib/utils";

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  faviconPath?: string | null | undefined;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const physicalProjectKey = derivePhysicalProjectKeyFromPath(input.environmentId, input.cwd);
  const source = useAtomValue(projectFaviconSourcesAtom).get(physicalProjectKey);
  const projectKey = source?.projectKey ?? physicalProjectKey;
  const loadedFavicon = useSyncExternalStore(
    useCallback((listener) => subscribeProjectFavicons(projectKey, listener), [projectKey]),
    useCallback(() => getLoadedProjectFavicon(projectKey), [projectKey]),
  );
  const state = useProjectFaviconAsset(source ?? input);
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;
  const faviconIsMissing = state._tag === "Success" && isProjectFaviconFallbackUrl(state.url);

  useEffect(() => {
    if (faviconIsMissing) forgetProjectFavicon(projectKey);
  }, [faviconIsMissing, projectKey]);

  const favicon =
    state._tag === "Success" && !faviconIsMissing
      ? {
          cacheKey: getProjectFaviconCacheKey(
            source?.environmentId ?? input.environmentId,
            source?.cwd ?? input.cwd,
            state.url,
          ),
          src: state.url,
        }
      : faviconIsMissing
        ? null
        : (loadedFavicon ?? null);

  if (favicon === null) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  return (
    <ProjectFaviconImage
      key={projectKey}
      projectKey={projectKey}
      cacheKey={favicon.cacheKey}
      src={favicon.src}
      className={input.className}
      fallbackIcon={FallbackIcon}
    />
  );
}

export function useProjectFaviconAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}) {
  return useAssetUrlState(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
    ...(input.faviconPath ? { path: input.faviconPath } : {}),
  });
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  projectKey,
  cacheKey,
  src,
  className,
  fallbackIcon: FallbackIcon,
}: {
  readonly projectKey: string;
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => getLoadedProjectFavicon(projectKey)?.src ?? null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    forgetProjectFavicon(projectKey, failedSrc);
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            rememberProjectFavicon(projectKey, { cacheKey, src });
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
