import type { ManagedPolicySummary } from "@t3tools/contracts";
import { BuildingIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * A control an administrator's policy turns off: shown inert, with the policy's reason on hover
 * and focus. Without a reason it renders the control untouched.
 */
export function ManagedControl({
  reason,
  children,
}: {
  reason: string | undefined;
  children: ReactNode;
}) {
  if (reason === undefined) return children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="group"
            aria-disabled="true"
            aria-label={reason}
            className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <span inert className="inline-flex opacity-50">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{reason}</TooltipPopup>
    </Tooltip>
  );
}

/** One line of policy text with the building mark, for places a whole feature is managed. */
export function ManagedNotice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-muted-foreground text-xs leading-relaxed">
      <BuildingIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** "This environment is managed by <organization>", linking the support page when there is one. */
export function ManagedByOrganization({ policy }: { policy: ManagedPolicySummary }) {
  return (
    <ManagedNotice>
      This environment is managed by {policy.organization}.
      {policy.supportUrl ? (
        <>
          {" "}
          <a
            href={policy.supportUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            Get help
          </a>
        </>
      ) : null}
    </ManagedNotice>
  );
}
