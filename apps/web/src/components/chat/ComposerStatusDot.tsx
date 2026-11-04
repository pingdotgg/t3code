import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { useComposerMenuProps } from "./composerEventScope";

const GROUPS = ["environment", "attention"] as const;
const SEVERITY: ReadonlyArray<ComposerBannerVariant> = ["error", "warning", "default", "info"];

const variantColor: Record<ComposerBannerVariant, string> = {
  default: "text-info",
  error: "text-error",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
};

/** One dot beside Send stands for every notice; clicking it opens the list. */
export function ComposerStatusDot({
  items,
}: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}) {
  const menuProps = useComposerMenuProps();
  if (items.length === 0) return null;
  const ordered = GROUPS.flatMap((group) =>
    items.filter((item) => (item.group ?? "attention") === group),
  );
  const variant =
    SEVERITY.find((candidate) => items.some((item) => item.variant === candidate)) ?? "success";
  const label =
    items.length === 1 && typeof items[0]?.title === "string"
      ? items[0].title
      : `${items.length} notices`;
  return (
    <Popover>
      <span role="status" className="sr-only">
        {label}
      </span>
      <PopoverTrigger
        render={<Button size="icon-sm" variant="ghost" className="shrink-0" />}
        aria-label={label}
        data-composer-status-dot={variant}
        data-chat-composer-collapsed-controls="true"
      >
        {items.length === 1 ? (
          <span
            aria-hidden
            className={cn(
              "flex size-5 items-center justify-center rounded-full border-2 border-current/35",
              variantColor[variant],
            )}
          >
            <ComposerBanner.Dot />
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-6 items-center justify-center rounded-full border border-current bg-current/15 font-mono text-2xs font-semibold tabular-nums",
              variantColor[variant],
            )}
          >
            {items.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="lg" padding="none" {...menuProps}>
        <div className="flex flex-col gap-px p-1 text-xs">
          {ordered.map((item) => (
            <div
              key={item.id}
              role={item.variant === "error" || item.variant === "warning" ? "alert" : undefined}
              className={cn(
                "flex flex-col gap-1 rounded-md px-2.5 py-1.5",
                item.variant === "error" && "bg-error/6",
              )}
            >
              <div className="flex min-h-6 min-w-0 items-center gap-2">
                <ComposerBanner.Dot className={variantColor[item.variant]} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 font-medium wrap-anywhere">{item.title}</span>
                  {item.description ? (
                    <span className="min-w-0 text-muted-foreground wrap-anywhere">
                      {item.description}
                    </span>
                  ) : null}
                </div>
                {item.actions || item.onDismiss ? (
                  <span className="flex flex-none items-center gap-1">
                    {item.actions}
                    {item.onDismiss ? (
                      <ComposerBanner.Dismiss
                        aria-label={item.dismissLabel ?? "Dismiss warning"}
                        onClick={item.onDismiss}
                      />
                    ) : null}
                  </span>
                ) : null}
              </div>
              {item.children ? <div className="ps-3.5">{item.children}</div> : null}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
