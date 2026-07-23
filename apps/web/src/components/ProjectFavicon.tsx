import type { EnvironmentId } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrl } from "../assets/assetUrls";
import { useEnvironmentSettings } from "../hooks/useSettings";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const configuredIconRevision = useEnvironmentSettings(input.environmentId, (settings) => {
    const pathIcon = settings.projectIcons[input.cwd];
    if (pathIcon) return `path:${pathIcon}`;
    const remoteEntries = Object.entries(settings.projectIconsByGitRemote);
    return remoteEntries.length === 0 ? undefined : `remotes:${JSON.stringify(remoteEntries)}`;
  });
  const src = useAssetUrl(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
    ...(configuredIconRevision ? { revision: configuredIconRevision } : {}),
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

  return (
    <>
      {status !== "loaded" ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      <img
        src={src}
        alt=""
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
