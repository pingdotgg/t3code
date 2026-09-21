import { PencilIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** Edit affordances stay visible on touch devices and reveal on hover or focus. */
export function PullRequestEditButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "render" | "size" | "variant"> & {
  "aria-label": string;
}) {
  return (
    <Button
      {...props}
      size="icon-xs"
      variant="ghost"
      className={cn(
        "shrink-0 text-muted-foreground opacity-0 transition-opacity pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      <PencilIcon aria-hidden className="size-3" />
    </Button>
  );
}
