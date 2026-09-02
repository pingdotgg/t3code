import type { EnvironmentId } from "@t3tools/contracts";
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
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { selectProjectIcon, type ProjectIconName } from "../projectIconModel";
import { cn } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Map<string, string>();

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

const PROJECT_ICON_COLORS: Record<ProjectIconName, string> = {
  ai: "text-violet-600 dark:text-violet-400",
  book: "text-amber-600 dark:text-amber-400",
  braces: "text-purple-600 dark:text-purple-400",
  circuit: "text-teal-600 dark:text-teal-400",
  cloud: "text-sky-600 dark:text-sky-400",
  code: "text-blue-600 dark:text-blue-400",
  database: "text-cyan-600 dark:text-cyan-400",
  desktop: "text-indigo-600 dark:text-indigo-400",
  "folder-code": "text-orange-600 dark:text-orange-400",
  game: "text-emerald-600 dark:text-emerald-400",
  image: "text-pink-600 dark:text-pink-400",
  layers: "text-fuchsia-600 dark:text-fuchsia-400",
  mobile: "text-lime-600 dark:text-lime-400",
  music: "text-fuchsia-600 dark:text-fuchsia-400",
  package: "text-orange-600 dark:text-orange-400",
  security: "text-teal-600 dark:text-teal-400",
  server: "text-blue-600 dark:text-blue-400",
  shopping: "text-rose-600 dark:text-rose-400",
  terminal: "text-green-600 dark:text-green-400",
  test: "text-yellow-600 dark:text-yellow-400",
  video: "text-red-600 dark:text-red-400",
  web: "text-sky-600 dark:text-sky-400",
};

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  faviconPath?: string | null | undefined;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const state = useProjectFaviconAsset(input);
  const src = state._tag === "Success" ? state.url : null;
  const automaticIconName = input.fallbackIcon
    ? null
    : selectProjectIcon(input.projectName, input.cwd);
  const FallbackIcon =
    input.fallbackIcon ??
    (automaticIconName?.kind === "lucide" ? PROJECT_ICONS[automaticIconName.icon] : undefined);
  const fallbackEmoji = automaticIconName?.kind === "emoji" ? automaticIconName.emoji : undefined;
  const fallbackColorClassName =
    automaticIconName?.kind === "lucide" ? PROJECT_ICON_COLORS[automaticIconName.icon] : undefined;

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
