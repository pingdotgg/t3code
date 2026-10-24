import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A wide source viewport can leave the player only a few dozen pixels tall,
 * so below 7rem the message sits beside the actions instead of above them.
 * The message scrolls rather than clamps: a clamped flex item shrinks to zero
 * height before the buttons give up any space.
 */
export function PreviewLoadFailure({
  className,
  style,
  message,
  hint,
  actions,
}: {
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly message: string;
  readonly hint?: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "absolute inset-0 overflow-auto bg-background [container-type:size]",
        className,
      )}
      style={style}
    >
      <div className="flex size-full flex-col items-center justify-center gap-3 p-4 text-center [@container(max-height:7rem)]:flex-row [@container(max-height:7rem)]:gap-2 [@container(max-height:7rem)]:px-2 [@container(max-height:7rem)]:py-0.5">
        <div className="max-h-full min-h-0 overflow-y-auto break-all text-xs text-muted-foreground [@container(max-height:7rem)]:min-w-0 [@container(max-height:7rem)]:flex-1 [@container(max-height:7rem)]:text-left">
          <p>{message}</p>
          {hint ? <p>{hint}</p> : null}
        </div>
        <div className="flex shrink-0 gap-2">{actions}</div>
      </div>
    </div>
  );
}
