import type { EnvironmentId, ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import {
  BotIcon,
  BookOpenIcon,
  BracesIcon,
  CircuitBoardIcon,
  CloudCogIcon,
  Code2Icon,
  DatabaseIcon,
  FlaskConicalIcon,
  FolderCodeIcon,
  Gamepad2Icon,
  Globe2Icon,
  ImageIcon,
  Layers3Icon,
  MonitorIcon,
  MusicIcon,
  PackageIcon,
  ServerIcon,
  ShieldCheckIcon,
  ShoppingBagIcon,
  SmartphoneIcon,
  TerminalIcon,
  VideoIcon,
} from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import type { ComponentType } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { selectProjectIcon, type ProjectIconName } from "../projectIconModel";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Map<string, string>();
const projectFaviconColors = new Map<string, string | null | Promise<string | null>>();
const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-[inherit]" />;
}

const PROJECT_ICONS: Record<ProjectIconName, ComponentType<{ className?: string }>> = {
  ai: BotIcon,
  book: BookOpenIcon,
  braces: BracesIcon,
  circuit: CircuitBoardIcon,
  cloud: CloudCogIcon,
  code: Code2Icon,
  database: DatabaseIcon,
  desktop: MonitorIcon,
  "folder-code": FolderCodeIcon,
  game: Gamepad2Icon,
  image: ImageIcon,
  layers: Layers3Icon,
  mobile: SmartphoneIcon,
  music: MusicIcon,
  package: PackageIcon,
  security: ShieldCheckIcon,
  server: ServerIcon,
  shopping: ShoppingBagIcon,
  terminal: TerminalIcon,
  test: FlaskConicalIcon,
  video: VideoIcon,
  web: Globe2Icon,
};

const PROJECT_ICON_COLOR_BY_NAME: Record<ProjectIconName, ProjectIconColor> = {
  ai: "violet",
  book: "amber",
  braces: "purple",
  circuit: "teal",
  cloud: "sky",
  code: "blue",
  database: "cyan",
  desktop: "indigo",
  "folder-code": "orange",
  game: "emerald",
  image: "pink",
  layers: "fuchsia",
  mobile: "lime",
  music: "fuchsia",
  package: "orange",
  security: "teal",
  server: "blue",
  shopping: "rose",
  terminal: "green",
  test: "yellow",
  video: "red",
  web: "sky",
};

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  faviconPath?: string | null | undefined;
  projectIcon?: ProjectIconOverride | null | undefined;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const state = useProjectFaviconAsset(input);
  const src = state._tag === "Success" ? state.url : null;
  if (input.projectIcon?.kind === "emoji") {
    return <ProjectFaviconFallback className={input.className} emoji={input.projectIcon.emoji} />;
  }
  if (input.projectIcon?.kind === "lucide") {
    const colorClassName = projectIconColorClassName(input.projectIcon.color);
    const iconClassName = cn(
      "inline-flex size-3.5 shrink-0 items-center justify-center",
      colorClassName,
      input.className,
    );
    return (
      <span aria-hidden="true" className={iconClassName}>
        <Suspense fallback={<DynamicProjectIconFallback />}>
          <DynamicIcon
            name={input.projectIcon.name as IconName}
            className={cn("size-full", colorClassName)}
            fallback={DynamicProjectIconFallback}
          />
        </Suspense>
      </span>
    );
  }
  const automaticIconName = input.fallbackIcon
    ? null
    : selectProjectIcon(input.projectName, input.cwd);
  const FallbackIcon =
    input.fallbackIcon ??
    (automaticIconName?.kind === "lucide" ? PROJECT_ICONS[automaticIconName.icon] : undefined);
  const fallbackEmoji = automaticIconName?.kind === "emoji" ? automaticIconName.emoji : undefined;
  const fallbackColorClassName =
    automaticIconName?.kind === "lucide"
      ? projectIconColorClassName(PROJECT_ICON_COLOR_BY_NAME[automaticIconName.icon])
      : undefined;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return (
      <ProjectFaviconFallback
        className={input.className}
        colorClassName={fallbackColorClassName}
        icon={FallbackIcon}
        emoji={fallbackEmoji}
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
      fallbackEmoji={fallbackEmoji}
      fallbackColorClassName={fallbackColorClassName}
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

export function useProjectFaviconColor(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
  readonly enabled?: boolean | undefined;
}) {
  const state = useProjectFaviconAsset(input);
  const src =
    input.enabled !== false && state._tag === "Success" && !isProjectFaviconFallbackUrl(state.url)
      ? state.url
      : null;
  const cacheKey =
    src === null ? null : getProjectFaviconCacheKey(input.environmentId, input.cwd, src);
  const [sample, setSample] = useState<{ cacheKey: string; color: string | null } | null>(() => {
    if (cacheKey === null) return null;
    const cached = projectFaviconColors.get(cacheKey);
    return typeof cached === "string" || cached === null ? { cacheKey, color: cached } : null;
  });

  useEffect(() => {
    if (cacheKey === null || src === null) return;
    let cancelled = false;
    void loadProjectFaviconColor(cacheKey, src).then((color) => {
      if (!cancelled) setSample({ cacheKey, color });
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, src]);

  return sample?.cacheKey === cacheKey ? sample.color : null;
}

function loadProjectFaviconColor(cacheKey: string, src: string): Promise<string | null> {
  const cached = projectFaviconColors.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

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
  projectFaviconColors.set(cacheKey, pending);
  void pending.then((color) => {
    if (projectFaviconColors.get(cacheKey) === pending) projectFaviconColors.set(cacheKey, color);
  });
  return pending;
}

export function extractProjectFaviconColor(data: Uint8ClampedArray): string | null {
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  for (let index = 0; index < data.length; index += 4) {
    const pixelRed = data[index];
    const pixelGreen = data[index + 1];
    const pixelBlue = data[index + 2];
    const pixelAlpha = data[index + 3];
    if (
      pixelRed === undefined ||
      pixelGreen === undefined ||
      pixelBlue === undefined ||
      pixelAlpha === undefined
    ) {
      continue;
    }
    const alpha = pixelAlpha / 255;
    if (alpha < 0.2) continue;
    const maximum = Math.max(pixelRed, pixelGreen, pixelBlue);
    const minimum = Math.min(pixelRed, pixelGreen, pixelBlue);
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
    const pixelWeight = alpha * (0.25 + saturation);
    red += pixelRed * pixelWeight;
    green += pixelGreen * pixelWeight;
    blue += pixelBlue * pixelWeight;
    weight += pixelWeight;
  }
  if (weight === 0) return null;
  return `rgb(${Math.round(red / weight)} ${Math.round(green / weight)} ${Math.round(blue / weight)})`;
}

function ProjectFaviconFallback({
  className,
  colorClassName,
  icon: Icon,
  emoji,
}: {
  readonly className?: string | undefined;
  readonly colorClassName?: string | undefined;
  readonly icon?: ComponentType<{ className?: string }> | undefined;
  readonly emoji?: string | undefined;
}) {
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

  if (!Icon) return null;
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", colorClassName, className)} />;
}

function ProjectFaviconImage({
  cacheKey,
  src,
  className,
  fallbackIcon: FallbackIcon,
  fallbackEmoji,
  fallbackColorClassName,
}: {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon?: ComponentType<{ className?: string }> | undefined;
  readonly fallbackEmoji?: string | undefined;
  readonly fallbackColorClassName?: string | undefined;
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

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback
          className={className}
          colorClassName={fallbackColorClassName}
          icon={FallbackIcon}
          emoji={fallbackEmoji}
        />
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
            loadedProjectFaviconSrcs.set(cacheKey, src);
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
