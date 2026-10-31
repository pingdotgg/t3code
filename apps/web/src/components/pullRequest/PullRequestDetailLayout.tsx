import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export function PullRequestDetailTitleRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-h-7 min-w-0 items-center sm:min-h-6", className)} {...props} />
  );
}
