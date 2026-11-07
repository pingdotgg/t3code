import { RefreshIcon } from "~/components/ui/refresh-icon";
import { CheckIcon, CircleArrowUpIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

const DOWNLOAD_PROGRESS_RADIUS = 14;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

export type DesktopUpdateStatusIconState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "everything";

function normalizeDesktopUpdateDownloadPercent(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

function DesktopUpdateAvailableIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <DownloadIcon className="size-4" />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-sidebar-control-surface"
      />
    </span>
  );
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
          className="stroke-current/22"
          strokeWidth="1.5"
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
          strokeWidth="1.5"
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
      </svg>
      <DownloadIcon className="size-4" />
    </span>
  );
}

function DesktopUpdateDownloadedIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <RotateCwIcon className="size-4" />
      <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
        <CheckIcon className="size-2" strokeWidth={3} />
      </span>
    </span>
  );
}

export function DesktopUpdateStatusIcon({
  downloadPercent,
  isCheckAnimating,
  isCheckReturning,
  onCheckAnimationIteration,
  onCheckReturnComplete,
  status,
}: {
  readonly downloadPercent?: number | null;
  readonly isCheckAnimating?: boolean;
  readonly isCheckReturning?: boolean;
  readonly onCheckAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
  readonly onCheckReturnComplete?: () => void;
  readonly status: DesktopUpdateStatusIconState;
}) {
  const statusIcon =
    status === "available" ? (
      <DesktopUpdateAvailableIcon />
    ) : status === "downloading" ? (
      <DesktopUpdateDownloadingIcon percent={downloadPercent ?? null} />
    ) : status === "downloaded" ? (
      <DesktopUpdateDownloadedIcon />
    ) : status === "checking" ? (
      <RefreshIcon
        className="size-4"
        refreshing={isCheckAnimating === true}
        onAnimationIteration={onCheckAnimationIteration}
      />
    ) : (
      <CircleArrowUpIcon className="size-4" />
    );

  if (!isCheckAnimating && !isCheckReturning) return statusIcon;

  return (
    <span
      key={isCheckReturning ? "returning" : "checking"}
      className="relative grid size-4 place-items-center"
    >
      <span className="absolute inset-0 grid place-items-center motion-safe:desktop-update-check-outgoing motion-reduce:hidden">
        {isCheckReturning ? <RefreshIcon size="md" /> : <CircleArrowUpIcon className="size-4" />}
      </span>
      <span
        className="motion-safe:desktop-update-check-incoming"
        onAnimationEnd={isCheckReturning ? onCheckReturnComplete : undefined}
      >
        {statusIcon}
      </span>
    </span>
  );
}
