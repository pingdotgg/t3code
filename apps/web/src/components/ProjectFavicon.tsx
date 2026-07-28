import type { EnvironmentId } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrl, useRefreshAssetUrl } from "../assets/assetUrls";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const resource = { _tag: "project-favicon", cwd: input.cwd } as const;
  const src = useAssetUrl(input.environmentId, resource);
  // Clicking an icon re-issues its asset URL, which makes the server resolve
  // the project's icon from scratch. That is what picks up an icon that was
  // just added, replaced, or moved — the URL bakes in the file the server
  // found when it was minted, so cache-busting the old URL would keep
  // fetching the old file. Every icon for this project shares one query, so
  // they all refresh together.
  const refresh = useRefreshAssetUrl(input.environmentId, resource);
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;

  // The click is deliberately not consumed: it still bubbles to the
  // surrounding row, so pressing the icon both opens the row and refreshes.
  if (!src || isProjectFaviconFallbackUrl(src)) {
    return (
      <ProjectFaviconFallback className={input.className} icon={FallbackIcon} onClick={refresh} />
    );
  }

  return (
    <ProjectFaviconImage
      key={`${input.environmentId}:${input.cwd}`}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
      onClick={refresh}
    />
  );
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
  onClick,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
  readonly onClick?: (() => void) | undefined;
}) {
  const icon = <Icon className={`size-3.5 shrink-0 text-muted-foreground/50 ${className ?? ""}`} />;
  if (onClick === undefined) {
    return icon;
  }
  // A project showing the placeholder still needs a refresh target, otherwise
  // an icon it just gained could never be picked up by clicking. `contents`
  // keeps the wrapper out of layout while giving the click somewhere to land.
  return (
    <span className="contents" onClick={onClick}>
      {icon}
    </span>
  );
}

// Keyed by environment and cwd rather than `src`: switching projects resets
// stale image state, while refreshing one project's URL keeps its current
// image visible until the new bytes decode.
function ProjectFaviconImage({
  src,
  className,
  fallbackIcon: FallbackIcon,
  onClick,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly onClick: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  return (
    <>
      {status !== "loaded" ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} onClick={onClick} />
      ) : null}
      <img
        src={src}
        alt=""
        onClick={onClick}
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
