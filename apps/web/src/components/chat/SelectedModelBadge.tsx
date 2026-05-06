import { CheckIcon } from "lucide-react";

import { Badge } from "../ui/badge";

export function SelectedModelBadge() {
  return <CheckIcon className="size-3.5 shrink-0 text-blue-400" />;
}

export function DefaultBadge() {
  return (
    <Badge
      variant="outline"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center gap-0 ps-1.5 pe-1.5 py-0 text-[10px] font-semibold leading-none border-border/70 bg-muted/60 text-muted-foreground sm:h-4"
    >
      Default
    </Badge>
  );
}
