import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderCodeIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import type { ComponentType } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { projectFaviconUrlAtom } from "../state/assets";
import { deriveProjectIdentity } from "../projectIdentity";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

// One entry per favicon resource; a new src replaces the old sample so data URLs are not retained.
const projectFaviconColors = new Map<
  string,
  { readonly src: string; readonly color: string | null | Promise<string | null> }
>();

const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-[inherit]" />;
}

// The slice of a project that decides its icon. Every surface must pass the
// project record itself (or a snapshot spread from it) so the saved title, favicon
// and icon override always travel together. Passing a display label as the title
// changes the automatic icon, which is how the command palette drifted once.
export type ProjectFaviconProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
>;
export function ProjectFavicon(input: {
  project: ProjectFaviconProject;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const { project } = input;
  const src = useAtomValue(
    projectFaviconUrlAtom({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      faviconPath: project.faviconPath,
    }),
  );
  if (project.projectIcon?.kind === "emoji") {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FolderCodeIcon}
        emoji={project.projectIcon.emoji}
      />
    );
  }
  if (project.projectIcon?.kind === "lucide") {
    const colorClassName = projectIconColorClassName(project.projectIcon.color);
    const iconClassName = cn(
      "inline-flex size-3.5 shrink-0 items-center justify-center",
      colorClassName,
      input.className,
    );
    return (
      <span aria-hidden="true" className={iconClassName}>
        <Suspense fallback={<DynamicProjectIconFallback />}>
          <DynamicIcon
            name={project.projectIcon.name as IconName}
            className={cn("size-full", colorClassName)}
            fallback={DynamicProjectIconFallback}
          />
        </Suspense>
      </span>
    );
  }
  const FallbackIcon = input.fallbackIcon ?? FolderCodeIcon;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FallbackIcon}
        projectName={project.title}
      />
    );
  }

  const cacheKey = getProjectFaviconResourceKey(
    project.environmentId,
    project.workspaceRoot,
    project.faviconPath,
  );

  return (
    <ProjectFaviconImage
      key={cacheKey}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
      fallbackProjectName={project.title}
    />
  );
}

export function useProjectFaviconColor(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}) {
  const assetUrl = useAtomValue(projectFaviconUrlAtom(input));
  const src = assetUrl && !isProjectFaviconFallbackUrl(assetUrl) ? assetUrl : null;
  const resourceKey = getProjectFaviconResourceKey(
    input.environmentId,
    input.cwd,
    input.faviconPath,
  );
  const [sample, setSample] = useState<{ src: string; color: string | null } | null>(() => {
    const cached = projectFaviconColors.get(resourceKey);
    return cached !== undefined && cached.src === src && !(cached.color instanceof Promise)
      ? { src: cached.src, color: cached.color }
      : null;
  });

  useEffect(() => {
    if (src === null) return;
    let cancelled = false;
    void loadProjectFaviconColor(resourceKey, src).then((color) => {
      if (!cancelled) setSample({ src, color });
    });
    return () => {
      cancelled = true;
    };
  }, [resourceKey, src]);

  return src !== null && sample !== null && sample.src === src ? sample.color : null;
}

function loadProjectFaviconColor(resourceKey: string, src: string): Promise<string | null> {
  const cached = projectFaviconColors.get(resourceKey);
  if (cached?.src === src) return Promise.resolve(cached.color);

  const pending = new Promise<string | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.addEventListener("load", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(
          extractProjectFaviconColor(context.getImageData(0, 0, canvas.width, canvas.height).data),
        );
      } catch {
        resolve(null);
      }
    });
    image.addEventListener("error", () => resolve(null));
    image.src = src;
  });
  projectFaviconColors.set(resourceKey, { src, color: pending });
  void pending.then((color) => {
    if (projectFaviconColors.get(resourceKey)?.color === pending) {
      projectFaviconColors.set(resourceKey, { src, color });
    }
  });
  return pending;
}

/** Samples the strongest hue family, excluding transparent padding and neutral backgrounds. */
export function extractProjectFaviconColor(data: Uint8ClampedArray): string | null {
  const hues = Array.from({ length: 12 }, () => ({ red: 0, green: 0, blue: 0, weight: 0 }));
  for (let index = 0; index + 3 < data.length; index += 4) {
    const red = data[index]!;
    const green = data[index + 1]!;
    const blue = data[index + 2]!;
    const alpha = data[index + 3]! / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const chroma = maximum - minimum;
    if (alpha < 0.2 || chroma < 24 || maximum < 40) continue;

    const hue =
      maximum === red
        ? (green - blue) / chroma
        : maximum === green
          ? (blue - red) / chroma + 2
          : (red - green) / chroma + 4;
    const bucket = hues[Math.round((hue + 6) * 2) % hues.length]!;
    const weight = alpha * chroma;
    bucket.red += red * weight;
    bucket.green += green * weight;
    bucket.blue += blue * weight;
    bucket.weight += weight;
  }

  const dominant = hues.reduce((best, hue) => (hue.weight > best.weight ? hue : best));
  if (dominant.weight === 0) return null;
  return `rgb(${Math.round(dominant.red / dominant.weight)} ${Math.round(dominant.green / dominant.weight)} ${Math.round(dominant.blue / dominant.weight)})`;
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
  emoji,
  projectName,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
  readonly emoji?: string | undefined;
  readonly projectName?: string | undefined;
}) {
  if (projectName && projectName.trim().length > 0) {
    const identity = deriveProjectIdentity(projectName);
    // Wrapped like the emoji and Lucide branches so the monogram sits where an
    // <img> favicon would. Menu items, buttons and the like pull every bare svg
    // in with [&_svg]:-mx-0.5 to trim the padding stroke icons carry, and this
    // tile has no such padding.
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-full overflow-hidden rounded-[25%] font-mono select-none"
          style={{
            backgroundColor: identity.background,
            backgroundImage: `linear-gradient(145deg, ${identity.highlight}, ${identity.background} 72%)`,
          }}
        >
          <text
            x="8"
            y="10.8"
            textAnchor="middle"
            fill="white"
            className="font-mono"
            fontSize="8.25"
            fontWeight="700"
            textLength="12"
            lengthAdjust="spacingAndGlyphs"
            textRendering="geometricPrecision"
          >
            {identity.monogram}
          </text>
          <rect
            x="0.25"
            y="0.25"
            width="15.5"
            height="15.5"
            rx="3.75"
            fill="none"
            strokeWidth="0.5"
            className="stroke-black/10 dark:stroke-white/10"
          />
        </svg>
      </span>
    );
  }

  if (emoji) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{emoji}</span>
      </span>
    );
  }

  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  src,
  className,
  fallbackIcon: FallbackIcon,
  fallbackProjectName,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly fallbackProjectName?: string | undefined;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(() =>
    src.startsWith("data:image/") ? src : null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback
          className={className}
          icon={FallbackIcon}
          projectName={fallbackProjectName}
        />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-[37.5%] object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
