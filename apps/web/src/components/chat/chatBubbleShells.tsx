import { type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Presentational shells for chat message bubbles.
 *
 * Both the live timeline (`MessagesTimeline` / `TimelineRowContent`) and the
 * appearance-settings preview render bubbles through these components so their
 * styling stays in lockstep. Shells are strictly presentational — no context,
 * no callbacks, no data-shape assumptions. Interactive chrome (copy, revert,
 * markdown, etc.) lives in the caller.
 */

/**
 * Scope that activates chat font-size scaling for its subtree.
 *
 * Sets the `--chat-font-size` CSS variable inline and marks the element with
 * `data-timeline-root` so the derived `--chat-text-*` variables and the
 * `text-chat-*` / `.chat-markdown` rules in `index.css` resolve correctly.
 *
 * The live timeline splits these two concerns across the LegendList wrapper
 * and the per-row element; standalone consumers (e.g. the settings preview)
 * can set both on a single wrapper via this component.
 */
export function ChatFontSizeScope({
  fontSize,
  style,
  children,
  ...rest
}: { fontSize: number; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      {...rest}
      data-timeline-root="true"
      style={{ "--chat-font-size": `${fontSize}px`, ...style } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * Right-aligned user message bubble shell: the outer flex alignment plus the
 * rounded `bg-secondary` pill. Inner `group` class is preserved so descendants
 * can use `group-hover:` for hover-revealed actions.
 */
export function UserMessageBubbleShell({
  children,
  className,
  innerClassName,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <div className={cn("flex justify-end", className)}>
      <div
        className={cn(
          "group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3",
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Assistant message shell: no background, tight padding, `min-w-0` so markdown
 * content can shrink inside flex containers without overflowing.
 */
export function AssistantMessageBubbleShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("min-w-0 px-1 py-0.5", className)}>{children}</div>;
}
