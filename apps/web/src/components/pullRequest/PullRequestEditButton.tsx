import { PencilIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { definePluginComponent } from "~/plugins/features";

export const PullRequestEditButton = definePluginComponent(
  "component:components/pullRequest/PullRequestEditButton/PullRequestEditButton",
  PluginOriginalPullRequestEditButton,
);

function PluginOriginalPullRequestEditButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "render" | "size" | "variant"> & {
  "aria-label": string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 opacity-0 transition-opacity pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      <Button {...props} size="icon-xs" variant="ghost-muted">
        <PencilIcon aria-hidden className="size-3" />
      </Button>
    </span>
  );
}
