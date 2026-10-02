import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

/**
 * The inline pill for one piece of chat context. It lives with the chat components rather than
 * in components/ui because it is one feature's look, not a generic primitive.
 *
 * An inline pill for one piece of context (a file, mention, terminal excerpt, pull request,
 * skill…) that sits in running text, both in the composer and in sent messages.
 *
 * Metrics are in em so the chip scales with the text around it (the composer honors the
 * prompt font-size preference). Each kind keeps one restrained color identity: every accent
 * shares a lightness so no kind reads heavier than another, and only hue carries identity.
 * A consumer may override `--context-chip-accent` through `style` for a color that comes
 * from content, such as an image's average color.
 *
 * Renders a span by default. Render it as a button, link or popover/tooltip trigger to make it
 * interactive; the hover tint follows from that, not from a prop. Anything focusable (including a
 * span with tabIndex for a tooltip) gets the focus outline.
 */
const contextChipVariants = cva(
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle font-medium text-[0.86em] leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "border-border/70 bg-accent/40 text-foreground",
        image: "[--context-chip-accent:oklch(0.62_0.16_16)]",
        video: "[--context-chip-accent:oklch(0.62_0.16_48)]",
        file: "[--context-chip-accent:oklch(0.62_0.136_237)]",
        mention: "[--context-chip-accent:oklch(0.62_0.11_215)]",
        terminal: "[--context-chip-accent:oklch(0.62_0.134_163)]",
        element: "[--context-chip-accent:oklch(0.62_0.134_70)]",
        "preview-annotation": "[--context-chip-accent:oklch(0.62_0.134_70)]",
        "review-comment": "[--context-chip-accent:oklch(0.62_0.16_292)]",
        "pull-request": "[--context-chip-accent:oklch(0.62_0.16_277)]",
        "pr-open": "[--context-chip-accent:oklch(0.62_0.134_163)]",
        "pr-draft": "[--context-chip-accent:oklch(0.62_0.02_259)]",
        "pr-merged": "[--context-chip-accent:oklch(0.62_0.16_292)]",
        "pr-closed": "[--context-chip-accent:oklch(0.62_0.16_16)]",
        skill: "[--context-chip-accent:oklch(0.62_0.16_322)]",
        thread: "[--context-chip-accent:oklch(0.62_0.12_190)]",
        citation: "[--context-chip-accent:oklch(0.62_0.16_259)]",
      },
      // Colors live in compoundVariants below so they come after the kind colors.
      state: {
        unresolved: "border-dashed",
        invalid: "",
      },
    },
    compoundVariants: [
      {
        kind: [
          "image",
          "video",
          "file",
          "mention",
          "terminal",
          "element",
          "preview-annotation",
          "review-comment",
          "pull-request",
          "pr-open",
          "pr-draft",
          "pr-merged",
          "pr-closed",
          "skill",
          "thread",
          "citation",
        ],
        className:
          "[--context-chip-border:color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] [--context-chip-border-hover:color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] [--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] border-(--context-chip-border) bg-(--context-chip-accent)/11 text-(--context-chip-foreground) [button:enabled&,a&]:hover:border-(--context-chip-border-hover) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17",
      },
      // State colors win over any kind.
      { state: "unresolved", className: "text-foreground" },
      { state: "invalid", className: "border-destructive/35 bg-destructive/8 text-destructive" },
    ],
  },
);

type ContextChipKind = NonNullable<VariantProps<typeof contextChipVariants>["kind"]>;

interface ContextChipProps extends useRender.ComponentProps<"span"> {
  kind?: ContextChipKind;
  state?: "unresolved" | "invalid";
}

function ContextChip({ className, kind, state, render, ...props }: ContextChipProps) {
  const defaultProps = {
    className: cn(contextChipVariants({ kind, state }), className),
    "data-slot": "context-chip",
    "data-state": state,
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

/** The chip's text. Truncates to the chip's width. */
function ContextChipLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("block min-w-0 self-center truncate leading-tight", className)}
      data-slot="context-chip-label"
      {...props}
    />
  );
}

/** An icon action inside a chip, such as editing a citation's comment. Tints with the chip's kind. */
function ContextChipAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className: cn(
      "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-current transition-colors hover:bg-(--context-chip-accent,var(--color-foreground))/17 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-[0.85em]",
      className,
    ),
    "data-slot": "context-chip-action",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { ContextChip, ContextChipAction, ContextChipLabel, type ContextChipKind };
