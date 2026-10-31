import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";

import { Text } from "../ui/text";

const RADIUS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The same quiet, 32px download ring used by desktop updates, with model byte counts. */
export function VoiceModelDownloadProgress({
  model,
  size,
}: {
  model: EnvironmentSpeechModel | null;
  size: number;
}) {
  const downloaded = model?.downloaded;
  const percent =
    downloaded === undefined ? null : Math.min(100, Math.max(0, (downloaded / size) * 100));
  const label =
    model?.state === "verifying"
      ? "Verifying download…"
      : percent === null || downloaded === 0
        ? "Starting download…"
        : `Downloading (${Math.round(percent)}%)`;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        role="progressbar"
        aria-label="Speech model download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={label}
        className="relative grid size-8 shrink-0 place-items-center text-foreground"
      >
        <svg aria-hidden className="absolute inset-0 size-full -rotate-90" viewBox="0 0 32 32">
          <circle
            cx="16"
            cy="16"
            r={RADIUS}
            fill="none"
            className="stroke-current/12"
            strokeWidth="2"
          />
          <circle
            cx="16"
            cy="16"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - (percent ?? 0) / 100)}
            strokeLinecap="round"
            strokeWidth="2"
            className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
          />
        </svg>
        <DownloadIcon aria-hidden className="size-3" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <Text variant="meta" render={<p role="status" />}>
          {label}
        </Text>
        <Text variant="meta" tone="muted" numeric render={<p />}>
          {Math.round((downloaded ?? 0) / 1024 / 1024)} / {Math.round(size / 1024 / 1024)} MB
        </Text>
      </div>
    </div>
  );
}
