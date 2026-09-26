import { MorphIcon } from "morphicons/react";

import { ChevronDown, Terminal } from "lucide";

export function ToolGroupDisclosureIcon({
  expanded,
  className,
}: {
  expanded: boolean;
  className: string;
}) {
  return (
    <MorphIcon
      icon={expanded ? ChevronDown : Terminal}
      className={className}
      spring="snappy"
      reducedMotion="user"
    />
  );
}
