import { RefreshIcon } from "~/components/ui/refresh-icon";
import { cn } from "~/lib/utils";
import { CircleArrowUpIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

const DOWNLOAD_PROGRESS_RADIUS = 10;
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

function DesktopUpdateDownloadIcon({
  percent,
  complete,
}: {
  readonly percent: number | null;
  readonly complete: boolean;
}) {
  const normalizedPercent = complete ? 100 : normalizeDesktopUpdateDownloadPercent(percent);
  const progressOffset = DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - normalizedPercent / 100);

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none relative grid size-5 place-items-center"
    >
      <svg
        className={cn(
          "absolute inset-0 size-full -rotate-90 transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none",
          complete ? "scale-75 opacity-0 delay-150" : "scale-100 opacity-100",
        )}
        viewBox="0 0 24 24"
      >
        <circle
          cx="12"
          cy="12"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          className="stroke-current/22"
          strokeWidth="2"
        />
        <circle
          cx="12"
          cy="12"
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
      <span className="relative size-5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            "absolute inset-0 size-5 transition-[opacity,scale,rotate] duration-200 ease-in-out motion-reduce:transition-none",
            complete ? "scale-50 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
          )}
        >
          <path d="m8 12 4-4 4 4" />
          <path d="M12 16V8" />
        </svg>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            "desktop-update-restart-ease absolute inset-0 size-5 transition-[opacity,scale,rotate] duration-300 motion-reduce:transition-none",
            complete ? "scale-100 rotate-0 opacity-100 delay-100" : "scale-50 -rotate-90 opacity-0",
          )}
        >
          <path d="M19.4 8.5A8.2 8.2 0 1 0 20.2 12" />
          <path d="M15.2 8.5h5V3.5" />
        </svg>
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
    status === "downloading" || status === "downloaded" ? (
      <DesktopUpdateDownloadIcon
        percent={downloadPercent ?? null}
        complete={status === "downloaded"}
      />
    ) : status === "checking" ? (
      <RefreshIcon
        size="lg"
        refreshing={isCheckAnimating === true}
        onAnimationIteration={onCheckAnimationIteration}
      />
    ) : (
      <CircleArrowUpIcon className="size-5" />
    );

  if (!isCheckAnimating && !isCheckReturning) return statusIcon;

  return (
    <span
      key={isCheckReturning ? "returning" : "checking"}
      className="relative grid size-5 place-items-center"
    >
      <span className="absolute inset-0 grid place-items-center motion-safe:desktop-update-check-outgoing motion-reduce:hidden">
        {isCheckReturning ? <RefreshIcon size="lg" /> : <CircleArrowUpIcon className="size-5" />}
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
