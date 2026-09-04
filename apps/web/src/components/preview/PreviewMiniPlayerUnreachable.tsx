import { Button } from "~/components/ui/button";

import { describePreviewError } from "./errorCodeMessages";

interface Props {
  readonly url: string;
  readonly description: string;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/** Compact failed-navigation overlay for the floating mini-player. */
export function PreviewMiniPlayerUnreachable({ url, description, onRetry, onClose }: Props) {
  const host = safeHost(url) ?? url;
  const friendly = describePreviewError(description);

  return (
    <div className="pointer-events-auto absolute inset-0 z-[49] flex min-w-0 flex-col items-center justify-center gap-3 overflow-hidden rounded-xl bg-background px-4 text-center">
      <p className="min-w-0 max-w-full truncate text-xs font-medium text-foreground">
        Can&apos;t reach {host}
      </p>
      <p className="min-w-0 max-w-full text-[11px] leading-snug text-muted-foreground">
        {friendly}
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={onRetry}>
          Retry
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
