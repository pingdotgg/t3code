import {
  connectionStatusTitle,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentMachineKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function connectionPhaseDotClassName(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "connected":
      return "bg-success";
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

export function connectionPhasePingClassName(phase: EnvironmentConnectionPhase): string | null {
  return phase === "connecting" || phase === "reconnecting" ? "bg-warning/60 duration-2000" : null;
}

/** A machine icon with a static connection dot on its corner. It never animates, so lists can hold many. */
export function MachineStatusIcon({
  kind,
  phase,
  className,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly phase: EnvironmentConnectionPhase | null;
  readonly className?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <EnvironmentMachineIcon aria-hidden kind={kind} className={className} />
      {phase === null ? null : (
        <span
          role="img"
          aria-label={connectionStatusTitle({ phase, error: null, traceId: null })}
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background",
            connectionPhaseDotClassName(phase),
          )}
        />
      )}
    </span>
  );
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

export function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full motion-safe:animate-status-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
