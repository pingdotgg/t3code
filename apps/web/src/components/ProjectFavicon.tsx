import type { EnvironmentId } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrl } from "../assets/assetUrls";
import { useEnvironmentSettings } from "../hooks/useSettings";

const loadedProjectFaviconSrcs = new Set<string>();

function hashProjectFaviconRevision(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function projectFaviconSettingsRevision(
  settings: {
    readonly projectIcons: Readonly<Record<string, string>>;
    readonly projectIconsByGitRemote: Readonly<Record<string, string>>;
  },
  cwd: string,
): string | undefined {
  const pathIcon = settings.projectIcons[cwd];
  const remoteEntries = Object.entries(settings.projectIconsByGitRemote);
  if (!pathIcon && remoteEntries.length === 0) return undefined;
  const revisionSource = JSON.stringify(
    pathIcon
      ? ["path", pathIcon]
      : ["remotes", remoteEntries.sort(([left], [right]) => left.localeCompare(right))],
  );
  return `icons:${revisionSource.length}:${hashProjectFaviconRevision(revisionSource)}`;
}

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const configuredIconRevision = useEnvironmentSettings(input.environmentId, (settings) =>
    projectFaviconSettingsRevision(settings, input.cwd),
  );
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
