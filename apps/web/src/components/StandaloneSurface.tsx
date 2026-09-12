import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { cn, isMacPlatform } from "../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
  useEnvironmentStageLabel,
} from "./SidebarStageBackdrop";
import { T3CodeBrand } from "./T3Wordmark";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { Badge } from "./ui/badge";

/**
 * Page frame for screens shown outside the app shell: pairing, CLI connect,
 * and the root error view. The sidebar's topbar runs page-wide, carrying the
 * stage art on Dev and Nightly builds and naming the host on the right.
 * Content sits in a narrow centered column on the plain app canvas, with the
 * build version pinned to the bottom.
 */
export function StandaloneSurface({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <StageTopbar />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-12">
        {children}
      </main>
      <p className="px-5 pb-5 text-center text-[11px] text-muted-foreground/60">
        {APP_DISPLAY_NAME} {APP_VERSION}
      </p>
    </div>
  );
}

/**
 * Mirrors the sidebar header: stage art with the brand in white on Dev and
 * Nightly, otherwise a hairline bar with the brand and the stage pill.
 */
function StageTopbar() {
  const stageLabel = useEnvironmentStageLabel();
  const stageVariant = resolveSidebarStageBackdropVariant(stageLabel);
  const stagePillLabel = stageVariant
    ? null
    : resolveEnvironmentIdentificationPillLabel(stageLabel);

  return (
    <WorkspacePageHeader
      electron={isElectron}
      className={cn(
        "relative justify-between gap-4 overflow-hidden",
        isElectron && isMacPlatform(navigator.platform) && "pl-[90px] sm:pl-[90px]",
        stageVariant ? "text-white" : "border-b border-border",
      )}
    >
      {stageVariant ? (
        <div aria-hidden className="absolute inset-0">
          <StageBackdropArt variant={stageVariant} />
        </div>
      ) : null}
      <div className="relative flex h-7 shrink-0 items-center">
        <T3CodeBrand labelClassName={stageVariant ? "text-white/70" : undefined} />
        {stagePillLabel ? (
          <Badge
            className="ml-1 rounded-full px-1.5 text-muted-foreground"
            size="sm"
            variant="secondary"
          >
            {stagePillLabel}
          </Badge>
        ) : null}
      </div>
      <span
        className={cn(
          "relative truncate font-mono text-xs",
          stageVariant ? "text-white/80" : "text-muted-foreground",
        )}
      >
        {window.location.host}
      </span>
    </WorkspacePageHeader>
  );
}

/** Heading block shared by every standalone screen. */
export function StandaloneSurfaceHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="mb-4">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

/**
 * Grouped panel matching Settings sections. Direct children become rows
 * separated by hairlines; give each row its own padding.
 */
export function StandaloneSurfacePanel({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50",
        className,
      )}
    >
      {children}
    </div>
  );
}
