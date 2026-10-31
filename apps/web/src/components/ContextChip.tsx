import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

// Each kind uses a theme tint role so its fill and label remain readable in both themes.
const contextChipVariants = cva(
  "context-chip inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] border align-middle font-medium leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "border-transparent bg-muted text-foreground",
        image: "[--context-chip-accent:var(--context-chip-image)]",
        video: "[--context-chip-accent:var(--warning-foreground)]",
        file: "rounded-row border-transparent bg-(--context-reference-fill) text-foreground [&_svg]:size-3 [&_svg]:text-muted-foreground [button:enabled&,a&]:hover:surface-ghost-hover",
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
        environment: "[--context-chip-accent:var(--info-foreground)]",
        "doc-pdf": "[--context-chip-accent:var(--context-chip-doc-pdf)]",
        "doc-word": "[--context-chip-accent:var(--context-chip-doc-word)]",
        "doc-spreadsheet": "[--context-chip-accent:var(--context-chip-doc-spreadsheet)]",
        "doc-slides": "[--context-chip-accent:var(--context-chip-doc-slides)]",
        "doc-epub": "[--context-chip-accent:var(--context-chip-doc-epub)]",
        citation: "[--context-chip-accent:var(--info-foreground)]",
      },
      shape: {
        inline: "",
        bubble: "w-64 gap-2 rounded-2xl bg-message px-3 py-2 text-label text-message-foreground",
      },
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
          "environment",
          "doc-pdf",
          "doc-word",
          "doc-spreadsheet",
          "doc-slides",
          "doc-epub",
        ],
        className:
          "[--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--foreground))] border-transparent bg-(--context-chip-accent)/10 text-(--context-chip-foreground) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17",
      },
      { state: "unresolved", className: "border-border text-foreground" },
      { state: "invalid", className: "border-error/35 bg-error/10 text-error-foreground" },
    ],
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
      className={cn("block min-w-0 self-center truncate leading-tight", className)}
      data-slot="context-chip-label"
      {...props}
    />
  );
}

function ContextChipAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className: cn(
      "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-current transition-colors hover:bg-(--context-chip-accent,var(--color-foreground))/17 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-[0.85em]",
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
