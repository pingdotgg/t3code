import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const contextChipVariants = cva(
  "inline-flex max-w-full items-center gap-[0.2em] font-medium leading-[normal] text-(--context-chip-ink) [--context-chip-ink:var(--context-chip-accent)] [--document-icon-stroke:var(--context-chip-ink)] [&_svg]:block [&_svg]:size-[1em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "[--context-chip-accent:currentColor]",
        image: "[--context-chip-accent:var(--info-foreground)]",
        video: "[--context-chip-accent:var(--warning-foreground)]",
        file: "[--context-chip-accent:var(--info-foreground)]",
        mention: "[--context-chip-accent:var(--info-foreground)]",
        terminal: "[--context-chip-accent:var(--success-foreground)]",
        element: "[--context-chip-accent:var(--warning-foreground)]",
        "preview-annotation": "[--context-chip-accent:var(--warning-foreground)]",
        "review-comment": "[--context-chip-accent:var(--merged-foreground)]",
        "pull-request": "[--context-chip-accent:var(--merged-foreground)]",
        "pr-open": "[--context-chip-accent:var(--success-foreground)]",
        "pr-draft": "[--context-chip-accent:var(--muted-foreground)]",
        "pr-merged": "[--context-chip-accent:var(--merged-foreground)]",
        "pr-closed": "[--context-chip-accent:var(--error-foreground)]",
        skill: "[--context-chip-accent:var(--merged-foreground)]",
        thread: "[--context-chip-accent:var(--info-foreground)]",
        environment: "[--context-chip-accent:var(--success-foreground)]",
        citation: "[--context-chip-accent:var(--info-foreground)]",
        "doc-pdf": "[--context-chip-accent:var(--error-foreground)]",
        "doc-word": "[--context-chip-accent:var(--info-foreground)]",
        "doc-spreadsheet": "[--context-chip-accent:var(--success-foreground)]",
        "doc-slides": "[--context-chip-accent:var(--warning-foreground)]",
        "doc-epub": "[--context-chip-accent:var(--merged-foreground)]",
      },
      shape: {
        inline: "",
        bubble: "w-64 gap-2 rounded-2xl surface-bubble px-3 py-2 text-label text-foreground",
      },
      state: {
        unresolved: "data-[state=unresolved]:[--context-chip-accent:currentColor]",
        invalid: "data-[state=invalid]:[--context-chip-accent:var(--error-foreground)]",
      },
    },
  },
);

type ContextChipKind = NonNullable<VariantProps<typeof contextChipVariants>["kind"]>;

interface ContextChipProps extends useRender.ComponentProps<"span"> {
  kind?: ContextChipKind;
  state?: "unresolved" | "invalid";
  shape?: "inline" | "bubble";
}

function ContextChip({ className, kind, state, shape, render, ...props }: ContextChipProps) {
  const defaultProps = {
    className: cn(contextChipVariants({ kind, state, shape }), className),
    "data-slot": "context-chip",
    "data-state": state,
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

function ContextChipLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "block min-w-0 self-baseline overflow-x-clip text-ellipsis whitespace-nowrap underline decoration-transparent decoration-1 underline-offset-[0.2em] transition-colors motion-reduce:transition-none [:is(button:enabled,a):hover>&]:decoration-current",
        className,
      )}
      data-slot="context-chip-label"
      {...props}
    />
  );
}

function ContextChipAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className: cn(
      "ml-[0.17em] inline-flex size-[1em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-current transition-colors hover:bg-(--context-chip-accent,var(--color-foreground))/17 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-[0.85em]",
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
