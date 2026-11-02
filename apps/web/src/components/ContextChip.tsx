import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

// Reference icons carry their kind color; media uses an accent tint.
// Consumers can override the media accent through style.
const contextChipVariants = cva(
  "context-chip inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] border align-middle font-medium leading-none [&_svg]:block [&_svg]:size-[1em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "border-transparent bg-muted text-foreground",
        image: "[--context-chip-accent:var(--context-chip-image)]",
        video: "[--context-chip-accent:var(--warning-foreground)]",
        file: "[--context-chip-icon:var(--muted-foreground)]",
        mention: "[--context-chip-icon:var(--muted-foreground)]",
        terminal: "[--context-chip-icon:var(--success-foreground)]",
        element: "[--context-chip-icon:var(--muted-foreground)]",
        "preview-annotation": "[--context-chip-icon:var(--muted-foreground)]",
        "review-comment": "[--context-chip-icon:var(--muted-foreground)]",
        "pull-request": "[--context-chip-icon:var(--muted-foreground)]",
        "pr-open": "[--context-chip-icon:var(--success-foreground)]",
        "pr-draft": "[--context-chip-icon:var(--muted-foreground)]",
        "pr-merged": "[--context-chip-icon:var(--merged-foreground)]",
        "pr-closed": "[--context-chip-icon:var(--error-foreground)]",
        skill: "[--context-chip-icon:var(--muted-foreground)]",
        thread: "[--context-chip-icon:var(--muted-foreground)]",
        // A neutral reference like a file: the quote glyph stays muted and only the comment action tints.
        // The action is a direct button child; its popover trigger replaces the context-chip-action slot.
        citation:
          "[--context-chip-accent:var(--info-foreground)] border-transparent bg-(--context-reference-fill) text-foreground [&_a_svg]:text-muted-foreground [&>button]:text-(--context-chip-accent)",
        environment: "[--context-chip-icon:var(--muted-foreground)]",
        "doc-pdf":
          "[--context-chip-accent:var(--context-chip-doc-pdf)] [--context-chip-icon:var(--muted-foreground)]",
        "doc-word":
          "[--context-chip-accent:var(--context-chip-doc-word)] [--context-chip-icon:var(--muted-foreground)]",
        "doc-spreadsheet":
          "[--context-chip-accent:var(--context-chip-doc-spreadsheet)] [--context-chip-icon:var(--muted-foreground)]",
        "doc-slides":
          "[--context-chip-accent:var(--context-chip-doc-slides)] [--context-chip-icon:var(--muted-foreground)]",
        "doc-epub":
          "[--context-chip-accent:var(--context-chip-doc-epub)] [--context-chip-icon:var(--muted-foreground)]",
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
          "environment",
          "doc-pdf",
          "doc-word",
          "doc-spreadsheet",
          "doc-slides",
          "doc-epub",
        ],
        className:
          "border-transparent bg-(--context-reference-fill) text-foreground [&_svg]:text-(--context-chip-icon) [button:enabled&,a&]:hover:surface-ghost-hover",
      },
      {
        kind: ["image", "video"],
        className:
          "[--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--foreground))] border-transparent bg-(--context-chip-accent)/10 text-(--context-chip-foreground) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17",
      },
      // State colors win over any kind, icon included.
      {
        state: "unresolved",
        className: "border-border text-foreground [--context-chip-icon:currentColor]",
      },
      {
        state: "invalid",
        className:
          "border-error/35 bg-error/10 text-error-foreground [--context-chip-icon:currentColor]",
      },
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
      className={cn(
        "block min-w-0 self-center truncate leading-tight underline decoration-transparent decoration-1 underline-offset-[0.2em] transition-colors motion-reduce:transition-none [:is(button:enabled,a):hover>&]:decoration-current",
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
