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
        image:
          "rounded-lg border border-(--context-chip-accent)/30 bg-(--context-chip-accent)/10 px-1.5 [--context-chip-accent:var(--context-chip-image)]",
        video: "[--context-chip-accent:var(--context-chip-video)]",
        file: "[--context-chip-accent:var(--context-chip-file)]",
        mention: "[--context-chip-accent:var(--context-chip-mention)]",
        terminal: "[--context-chip-accent:var(--context-chip-terminal)]",
        element: "[--context-chip-accent:var(--context-chip-element)]",
        "preview-annotation": "[--context-chip-accent:var(--context-chip-preview-annotation)]",
        "review-comment": "[--context-chip-accent:var(--context-chip-review-comment)]",
        "pull-request": "[--context-chip-accent:var(--context-chip-pull-request)]",
        "pr-open": "[--context-chip-accent:var(--context-chip-pr-open)]",
        "pr-draft": "[--context-chip-accent:var(--context-chip-pr-draft)]",
        "pr-merged": "[--context-chip-accent:var(--context-chip-pr-merged)]",
        "pr-closed": "[--context-chip-accent:var(--context-chip-pr-closed)]",
        skill: "[--context-chip-accent:var(--context-chip-skill)]",
        thread: "[--context-chip-accent:var(--context-chip-thread)]",
        environment: "[--context-chip-accent:var(--context-chip-environment)]",
        citation: "[--context-chip-accent:var(--context-chip-citation)]",
        "doc-pdf": "[--context-chip-accent:var(--context-chip-doc-pdf)]",
        "doc-word": "[--context-chip-accent:var(--context-chip-doc-word)]",
        "doc-spreadsheet": "[--context-chip-accent:var(--context-chip-doc-spreadsheet)]",
        "doc-slides": "[--context-chip-accent:var(--context-chip-doc-slides)]",
        "doc-epub": "[--context-chip-accent:var(--context-chip-doc-epub)]",
      },
      state: {
        unresolved: "data-[state=unresolved]:[--context-chip-accent:currentColor]",
        invalid:
          "data-[state=invalid]:[--context-chip-accent:var(--context-chip-invalid,var(--destructive-foreground))]",
      },
    },
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
