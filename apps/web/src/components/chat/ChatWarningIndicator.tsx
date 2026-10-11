import {
  type EnvironmentId,
  type OrchestrationV2ProviderFailureClass,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "~/providerModels";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  getIncompatibleVersion,
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  hasProviderSetup,
} from "./ProviderStatusBanner";

export interface ChatWarning {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: "warning" | "error";
  readonly providerSetupInstanceId?: ProviderInstanceId;
}

export function resolveProviderChatWarning(
  environmentId: EnvironmentId,
  status: ServerProvider | null,
): ChatWarning | null {
  const key = getProviderStatusBannerKey(status);
  if (!status || key === null) return null;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const incompatible = getIncompatibleVersion(status);
  const needsAuthentication = status.status === "error" && status.auth.status === "unauthenticated";
  return {
    id: ["provider", environmentId, key].join("\u0000"),
    title: needsAuthentication
      ? `${providerName} needs authentication`
      : incompatible
        ? `${providerName} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
        : status.status === "error"
          ? `${providerName} is unavailable`
          : `${providerName} has limited availability`,
    description: incompatible?.message ?? getProviderStatusMessage(status),
    severity:
      incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null)
        ? "warning"
        : "error",
    ...(hasProviderSetup(status) ? { providerSetupInstanceId: status.instanceId } : {}),
  };
}

export function resolveThreadErrorChatWarning(
  threadKey: string,
  error: string | null,
  errorClass?: OrchestrationV2ProviderFailureClass | null,
): ChatWarning | null {
  return error
    ? {
        id: ["thread", threadKey, error].join("\u0000"),
        title: "Thread failed",
        description: error,
        severity: errorClass === "usage_limit" ? "warning" : "error",
      }
    : null;
}

export const ChatWarningIndicator = memo(function ChatWarningIndicator({
  warnings,
  canDismissForNow,
  onDismissForNow,
  onDismissForever,
  onOpenProviderSetup,
}: {
  readonly warnings: ReadonlyArray<ChatWarning>;
  readonly canDismissForNow: boolean;
  readonly onDismissForNow: (warningIds: ReadonlyArray<string>) => void;
  readonly onDismissForever: (warningIds: ReadonlyArray<string>) => void;
  readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
}) {
  if (warnings.length === 0) return null;

  const severity = warnings.some((warning) => warning.severity === "error") ? "error" : "warning";
  const warningIds = warnings.map(({ id }) => id);
  const isSingle = warnings.length === 1;
  const isError = severity === "error";
  const actionVariant = isError ? "ghost-error" : "ghost-warning";

  return (
    <>
      <span role="alert" className="sr-only">
        {warnings.map((warning) => `${warning.title}: ${warning.description}`).join(" ")}
      </span>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={100}
          closeDelay={200}
          render={
            <Button
              variant={isError ? "ghost-error-icon" : "ghost-warning-icon"}
              size="icon-circle-xs"
              aria-label={`${warnings.length} ${isSingle ? "warning" : "warnings"}`}
            />
          }
        >
          <CircleAlertIcon
            className={cn("size-4.5", isError ? "fill-destructive/12" : "fill-warning/12")}
            aria-hidden
          />
        </PopoverTrigger>
        <PopoverPopup
          tooltipStyle
          align="start"
          side="bottom"
          padding="none"
          width="sm"
          variant={severity}
          data-variant={severity}
        >
          <div className="space-y-2">
            {warnings.map((warning) => (
              <div key={warning.id}>
                <div className="text-xs leading-4 font-medium">{warning.title}</div>
                <div className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-4 opacity-75">
                  {warning.description}
                </div>
                {warning.providerSetupInstanceId ? (
                  <InlineButton
                    onClick={() => {
                      if (warning.providerSetupInstanceId)
                        onOpenProviderSetup(warning.providerSetupInstanceId);
                    }}
                  >
                    Open provider setup
                  </InlineButton>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-1">
            {canDismissForNow ? (
              <Button
                size="micro"
                variant={actionVariant}
                onClick={() => onDismissForNow(warningIds)}
              >
                {isSingle ? "Dismiss for now" : "Dismiss all for now"}
              </Button>
            ) : null}
            <Button
              size="micro"
              variant={actionVariant}
              onClick={() => onDismissForever(warningIds)}
            >
              {isSingle ? "Don't show again" : "Don't show these again"}
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
});
