import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const cardSectionVariants = cva("min-w-0", {
  defaultVariants: {
    divided: "none",
    padding: "default",
  },
  variants: {
    divided: {
      none: "",
      top: "border-t border-divider",
      bottom: "border-b border-divider",
    },
    padding: {
      default: "px-3 py-3 sm:px-4",
      compact: "pt-2",
      none: "",
    },
  },
});

/** A content section inside a card, optionally separated by a divider hairline. */
function CardSection({
  divided,
  padding,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof cardSectionVariants>) {
  const defaultProps = {
    "data-slot": "card-section",
    className: cn(cardSectionVariants({ divided, padding }), className),
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  });
}

export { CardSection };
