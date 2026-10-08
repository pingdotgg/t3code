import { ArrowUpRightIcon, MapPinIcon } from "lucide-react";
import type { LocationContextRecord } from "@t3tools/contracts";
import { sharedLocationMapsUrl } from "@t3tools/shared/sharedLocation";

export function SharedLocationCard(props: { record: LocationContextRecord; copyMarkdown: string }) {
  const location = props.record.payload;
  const title = location.name.trim() || location.address.trim() || "Shared location";
  const address = location.address.trim();
  const coordinates = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
  const mapsUrl = sharedLocationMapsUrl(location, "web");
  const capturedAt = formatCapturedAt(location.capturedAt);
  const accuracy =
    location.accuracy === null
      ? "Accuracy unknown"
      : `±${Math.round(location.accuracy)} m accuracy`;

  return (
    <a
      href={mapsUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open map for ${title}${address && address !== title ? `, ${address}` : ""}`}
      data-markdown-copy={props.copyMarkdown}
      className="group/location block overflow-hidden rounded-lg border border-border/70 bg-background/70 text-left transition-colors hover:border-border hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div
        className="relative h-[112px] overflow-hidden bg-muted/35 text-muted-foreground"
        aria-hidden="true"
      >
        <svg viewBox="0 0 420 112" className="size-full" preserveAspectRatio="xMidYMid slice">
          <path
            d="M0 18 420 94M-12 94 378 -8M92 112 176 -8M300 120 230 -8"
            fill="none"
            stroke="currentColor"
            strokeWidth="12"
            opacity=".12"
          />
          <path
            d="M0 18 420 94M-12 94 378 -8M92 112 176 -8M300 120 230 -8"
            fill="none"
            stroke="var(--background)"
            strokeWidth="7"
            opacity=".8"
          />
          <path
            d="M12 68c40-12 63-6 87 8s47 17 77 5 49-30 81-27 65 23 151 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="5 5"
            opacity=".3"
          />
          <circle cx="210" cy="55" r="24" fill="var(--primary)" opacity=".14" />
          <path
            d="M210 39c-8.3 0-15 6.6-15 14.8 0 10.7 15 25.2 15 25.2s15-14.5 15-25.2c0-8.2-6.7-14.8-15-14.8Z"
            fill="var(--primary)"
          />
          <circle cx="210" cy="54" r="5" fill="var(--primary-foreground)" />
        </svg>
        <span className="absolute right-2 top-2 rounded-full border border-border/60 bg-background/85 px-2 py-1 text-3xs font-medium text-muted-foreground backdrop-blur-sm">
          Location snapshot
        </span>
      </div>
      <div className="flex min-w-0 items-start gap-3 p-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MapPinIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="min-w-0 truncate">{title}</span>
            <ArrowUpRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground opacity-70 group-hover/location:opacity-100"
            />
          </span>
          {address && address !== title ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">{address}</span>
          ) : null}
          <span className="mt-1 block font-mono text-2xs tabular-nums text-muted-foreground">
            {coordinates}
          </span>
          {accuracy || capturedAt ? (
            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground/80">
              {accuracy ? <span>{accuracy}</span> : null}
              {capturedAt ? <span>Captured {capturedAt}</span> : null}
            </span>
          ) : null}
        </span>
      </div>
    </a>
  );
}

function formatCapturedAt(capturedAt: string | null | undefined): string | null {
  if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(capturedAt));
}
