import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";

const loadedProjectFaviconSrcs = new Set<string>();
const PROJECT_FAVICON_CACHE_VERSION = "2";

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
  isActive?: boolean;
}) {
  // When this project holds the active thread, show a themed open-folder icon
  // that matches the project name color, so the active project reads as one
  // cohesive, fully-lit unit. Inactive projects keep their resolved favicon
  // image (or the muted closed-folder fallback).
  if (input.isActive) {
    return (
      <FolderOpenIcon className={`size-3.5 shrink-0 text-foreground/90 ${input.className ?? ""}`} />
    );
  }

  return (
    <ResolvedProjectFavicon
      environmentId={input.environmentId}
      cwd={input.cwd}
      {...(input.className !== undefined ? { className: input.className } : {})}
    />
  );
}

function ResolvedProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
}) {
  const src = (() => {
    try {
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-favicon",
        searchParams: {
          cwd: input.cwd,
          v: PROJECT_FAVICON_CACHE_VERSION,
        },
      });
    } catch {
      return null;
    }
  })();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  if (!src) {
    return (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
      />
    );
  }

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon
          className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
        />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
