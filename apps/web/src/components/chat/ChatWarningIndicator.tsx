import { type ContextMenuItem, type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { formatProviderDriverKindLabel } from "~/providerModels";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface ChatWarning {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: "warning" | "error";
}

type ContextMenuAction =
  | `warning:${number}`
  | `dismiss-now:${number}`
  | `dismiss-forever:${number}`
  | "dismiss-all-now"
  | "dismiss-all-forever";

export function resolveProviderChatWarning(
  environmentId: EnvironmentId,
  status: ServerProvider | null,
): ChatWarning | null {
  if (!status || status.status === "ready" || status.status === "disabled") return null;

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const needsAuthentication = status.status === "error" && status.auth.status === "unauthenticated";
  const title = needsAuthentication
    ? `${providerName} needs authentication`
    : status.status === "error"
      ? `${providerName} is unavailable`
      : `${providerName} has limited availability`;
  const description = needsAuthentication
    ? `${status.message ? `${status.message}\n\n` : ""}Sign in through the ${providerName} CLI to authenticate again.`
    : (status.message ??
      `${providerName} ${status.status === "error" ? "could not start" : "reported limited availability"}. Check its provider settings for details.`);

  return {
    id: [
      "provider",
      environmentId,
      status.instanceId,
      status.status,
      status.auth.status,
      status.message ?? "",
    ].join("\u0000"),
    title,
    description,
    severity: status.status === "warning" ? "warning" : "error",
  };
}

export function resolveThreadErrorChatWarning(
  threadKey: string,
  error: string | null,
): ChatWarning | null {
  return error
    ? {
        id: ["thread", threadKey, error].join("\u0000"),
        title: "Thread failed",
        description: error,
        severity: "error",
      }
    : null;
}

function contextMenuItems(
  warnings: ReadonlyArray<ChatWarning>,
  canDismissForNow: boolean,
): ReadonlyArray<ContextMenuItem<ContextMenuAction>> {
  const actions = (index: number): ReadonlyArray<ContextMenuItem<ContextMenuAction>> => [
    ...(canDismissForNow
      ? ([{ id: `dismiss-now:${index}`, label: "Dismiss for now" }] as const)
      : []),
    { id: `dismiss-forever:${index}`, label: "Don't show again" },
  ];
  if (warnings.length === 1) return actions(0);
  return [
    ...warnings.map(
      (warning, index): ContextMenuItem<ContextMenuAction> => ({
        id: `warning:${index}`,
        label: warning.title,
        children: actions(index),
      }),
    ),
    ...(canDismissForNow
      ? ([{ id: "dismiss-all-now", label: "Dismiss all for now", separatorBefore: true }] as const)
      : []),
    { id: "dismiss-all-forever", label: "Don't show these again" },
  ];
}

export const ChatWarningIndicator = memo(function ChatWarningIndicator({
  warnings,
  canDismissForNow,
  onDismissForNow,
  onDismissForever,
}: {
  readonly warnings: ReadonlyArray<ChatWarning>;
  readonly canDismissForNow: boolean;
  readonly onDismissForNow: (warningIds: ReadonlyArray<string>) => void;
  readonly onDismissForever: (warningIds: ReadonlyArray<string>) => void;
}) {
  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      let action: ContextMenuAction | null;
      try {
        action = await api.contextMenu.show(contextMenuItems(warnings, canDismissForNow), {
          x: event.clientX,
          y: event.clientY,
        });
      } catch {
        // The native menu can disappear when its window closes.
        return;
      }
      if (action === null) return;
      if (action === "dismiss-all-now") return onDismissForNow(warnings.map(({ id }) => id));
      if (action === "dismiss-all-forever") {
        return onDismissForever(warnings.map(({ id }) => id));
      }
      const dismissForNow = action.startsWith("dismiss-now:");
      const warning = warnings[Number(action.slice(action.indexOf(":") + 1))];
      if (!warning) return;
      if (dismissForNow && canDismissForNow) onDismissForNow([warning.id]);
      if (!dismissForNow && action.startsWith("dismiss-forever:")) {
        onDismissForever([warning.id]);
      }
    },
    [canDismissForNow, onDismissForNow, onDismissForever, warnings],
  );

  if (warnings.length === 0) return null;

  const severity = warnings.some((warning) => warning.severity === "error") ? "error" : "warning";
  const warningIds = warnings.map(({ id }) => id);
  const isSingle = warnings.length === 1;
  const isError = severity === "error";
  const actionClassName = isError
    ? "text-error-foreground [:hover,[data-pressed]]:bg-destructive/10"
    : "text-warning-foreground [:hover,[data-pressed]]:bg-warning/10";

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
              variant="ghost"
              size="icon-xs"
              aria-label={`${warnings.length} ${isSingle ? "warning" : "warnings"}. Right-click to dismiss.`}
              className={cn(
                "size-6 shrink-0 rounded-full [--control-icon-color:currentColor]",
                isError
                  ? "text-destructive [:hover,[data-pressed]]:bg-destructive/10"
                  : "text-warning [:hover,[data-pressed]]:bg-warning/10",
              )}
              onContextMenu={(event) => void handleContextMenu(event)}
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
          viewportClassName="p-0"
          className={cn(
            "alert-glass w-64 max-w-[calc(100vw-1rem)] p-2.5 text-left",
            isError
              ? "border-destructive/40! text-error-foreground"
              : "border-warning/40! text-warning-foreground",
          )}
          data-variant={severity}
        >
          <div className="space-y-2">
            {warnings.map((warning) => (
              <div key={warning.id}>
                <div className="text-xs leading-4 font-medium">{warning.title}</div>
                <div className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-4 opacity-75">
                  {warning.description}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-1">
            {canDismissForNow ? (
              <Button
                size="micro"
                variant="ghost"
                className={actionClassName}
                onClick={() => onDismissForNow(warningIds)}
              >
                {isSingle ? "Dismiss for now" : "Dismiss all for now"}
              </Button>
            ) : null}
            <Button
              size="micro"
              variant="ghost"
              className={actionClassName}
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
