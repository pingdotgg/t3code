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

const variantTitleColor: Record<ComposerBannerVariant, string> = {
  default: "text-info-foreground",
  error: "text-error-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
};

/** One ring beside Send stands for every notice; clicking it opens the list. */
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
          // Static on purpose: a spinning ring repaints every frame.
          <svg
            aria-hidden
            viewBox="0 0 28 28"
            className={cn("size-7 shrink-0", variantColor[variant])}
          >
            <circle cx="14" cy="14" r="11" fill="none" stroke="var(--border)" strokeWidth="2.5" />
            <circle
              cx="14"
              cy="14"
              r="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="42.9 69.1"
              transform="rotate(-90 14 14)"
            />
            <circle cx="14" cy="14" r="3" fill="currentColor" />
          </svg>
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-7 items-center justify-center rounded-full border border-current bg-current/20 font-mono text-2xs font-semibold tabular-nums",
              variantColor[variant],
            )}
          >
            <span className={variantTitleColor[variant]}>{items.length}</span>
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md" padding="none" {...menuProps}>
        <div className="flex flex-col p-1 text-xs">
          {ordered.map((item) => (
            <div
              key={item.id}
              role={item.variant === "error" || item.variant === "warning" ? "alert" : undefined}
              className={cn("rounded-md px-2.5", item.variant === "error" && "bg-error/6")}
            >
              <div className="flex min-h-8 min-w-0 items-center gap-2">
                <ComposerBanner.Dot className={variantColor[item.variant]} />
                <span
                  className={cn(
                    "min-w-0 flex-1 py-1.5 wrap-anywhere",
                    variantTitleColor[item.variant],
                    item.variant === "error" && "font-medium",
                  )}
                >
                  {item.title}
                  {item.description ? (
                    <span className="opacity-80">
                      <ComposerBanner.Separator />
                      {item.description}
                    </span>
                  ) : null}
                </span>
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
              {item.children ? <div className="ps-3.5 pb-1.5">{item.children}</div> : null}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
