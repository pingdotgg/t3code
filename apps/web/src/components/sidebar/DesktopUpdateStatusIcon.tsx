import { RefreshIcon } from "~/components/ui/refresh-icon";
import { CheckIcon, CircleArrowUpIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

const DOWNLOAD_PROGRESS_RADIUS = 11;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

export type DesktopUpdateStatusIconState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "everything"
  | "failed";

function normalizeDesktopUpdateDownloadPercent(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function shouldShowDesktopUpdateCheckIcon({
  isAnimationLatched,
  isChecking,
  prefersReducedMotion,
}: {
  readonly isAnimationLatched: boolean;
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking || (isAnimationLatched && !prefersReducedMotion);
}

export function shouldContinueDesktopUpdateCheckAnimation({
  isChecking,
  prefersReducedMotion,
}: {
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking && !prefersReducedMotion;
}

function DesktopUpdateDownloadingIcon({ percent }: { readonly percent: number | null }) {
  const normalizedPercent = normalizeDesktopUpdateDownloadPercent(percent);
  const progressOffset = DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - normalizedPercent / 100);

  return (
    <span className="relative grid size-8 place-items-center">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full -rotate-90"
        viewBox="0 0 32 32"
      >
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          className="stroke-current/12"
          strokeWidth="2"
        />
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
          strokeDashoffset={progressOffset}
          strokeLinecap="round"
          strokeWidth="2"
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
      </svg>
      <DownloadIcon className="size-3" />
    </span>
  );
}

function DesktopUpdateDownloadedIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <RotateCwIcon className="size-4" />
      <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background">
        <CheckIcon className="size-2" strokeWidth={3} />
      </span>
    </span>
  );
}

function DesktopUpdateFailedIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <DownloadIcon className="size-4" />
      <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-destructive text-destructive-fill-foreground">
        <span className="h-1 w-px rounded-full bg-current" />
      </span>
    </span>
  );
}

export function DesktopUpdateStatusIcon({
  downloadPercent,
  isCheckAnimating,
  onCheckAnimationIteration,
  status,
}: {
  readonly downloadPercent?: number | null;
  readonly isCheckAnimating?: boolean;
  readonly onCheckAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
  readonly status: DesktopUpdateStatusIconState;
}) {
  if (status === "available") return <DownloadIcon className="size-4" />;
  if (status === "downloading") {
    return <DesktopUpdateDownloadingIcon percent={downloadPercent ?? null} />;
  }
  if (status === "downloaded") return <DesktopUpdateDownloadedIcon />;
  if (status === "everything") return <CircleArrowUpIcon className="size-4" />;
  if (status === "failed") return <DesktopUpdateFailedIcon />;

  return (
    <RefreshIcon
      className="size-4"
      refreshing={status === "checking" && isCheckAnimating === true}
      onAnimationIteration={onCheckAnimationIteration}
    />
  );
}
