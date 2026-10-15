import { createContext, use, useMemo, type ComponentProps, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSharedPopup, type SharedPopup } from "./useSharedPopup";

type DiagnosticsTooltipPayload = {
  tooltip: ReactNode;
  variant?: "default" | "code";
};

const DiagnosticsTooltipTriggerRefContext = createContext<SharedPopup["triggerRef"] | null>(null);

export function DiagnosticsTooltips({ children }: { children: ReactNode }) {
  const popup = useSharedPopup();
  return (
    <Tooltip<DiagnosticsTooltipPayload>
      actionsRef={popup.actionsRef}
      onOpenChange={popup.onOpenChange}
    >
      {({ payload }) => (
        <>
          <DiagnosticsTooltipTriggerRefContext value={popup.triggerRef}>
            {children}
          </DiagnosticsTooltipTriggerRefContext>
          <TooltipPopup side="top" variant={payload?.variant ?? "default"}>
            {payload?.tooltip}
          </TooltipPopup>
        </>
      )}
    </Tooltip>
  );
}

export function DiagnosticsTooltip({
  tooltip,
  variant,
  ...props
}: ComponentProps<typeof TooltipTrigger> & DiagnosticsTooltipPayload) {
  const triggerRef = use(DiagnosticsTooltipTriggerRefContext);
  const payload = useMemo(() => ({ tooltip, variant }), [tooltip, variant]);
  return <TooltipTrigger {...props} ref={triggerRef} payload={payload} />;
}
