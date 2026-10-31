import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

// One size and weight per role (pen QuGu9); the text-{role} tokens in
// index.css carry the line height and weight with the size.
const textVariants = cva("", {
  defaultVariants: { variant: "body", tone: "default" },
  variants: {
    variant: {
      /** 22/600: page and section titles. */
      title: "text-title",
      /** 14/400: typed text, such as the prompt, a search field or a chat bubble. */
      prompt: "text-prompt",
      /** 14/500: row titles, button and menu labels. */
      label: "text-label",
      /** 14/400: descriptions and running copy. */
      body: "text-body",
      /** 12/500: chips, metadata and small section headings. */
      meta: "text-meta",
      /** 11/500: key hints, status and captions. */
      caption: "text-caption",
      /** 10/500: status pills and counters inside tight chrome. */
      micro: "text-micro",
    },
    tone: {
      strong: "text-strong-foreground",
      default: "text-foreground",
      muted: "text-muted-foreground",
      dim: "text-dim-foreground",
      /** Field errors and destructive notes. */
      destructive: "text-destructive-foreground",
      /** Inherits the surrounding color, such as a status or button label. */
      inherit: "",
    },
    truncate: { true: "min-w-0 truncate" },
    /** Tabular digits, so counts and times do not shift as they change. */
    numeric: { true: "tabular-nums" },
    mono: { true: "font-mono" },
    /** Emphasized labels keep their role's size and line height. */
    emphasis: { true: "font-semibold" },
  },
});

type TextProps = Omit<useRender.ComponentProps<"span">, "className" | "style"> &
  VariantProps<typeof textVariants>;

/**
 * Text in one of the seven type roles. Pick the role and a tone; the element
 * defaults to a span, so pass `render={<h3 />}` or `render={<p />}` for
 * headings and paragraphs.
 */
function Text({ variant, tone, truncate, numeric, mono, emphasis, render, ...props }: TextProps) {
  return useRender({
    defaultTagName: "span",
    render,
    props: mergeProps<"span">(
      { className: textVariants({ variant, tone, truncate, numeric, mono, emphasis }) },
      props,
    ),
  });
}

export { Text, textVariants };
