import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import { useEnvironmentGlyphStore } from "../environmentGlyphStore";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";

/** A device-local glyph overrides the machine icon without changing server settings. */
export function EnvironmentBadgeIcon({
  environmentId,
  kind,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentMachineKind;
  readonly className?: string;
}) {
  const glyph = useEnvironmentGlyphStore((state) => state.byId[environmentId]);

  return glyph ? (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-xs leading-none font-medium select-none",
        className,
      )}
    >
      {glyph}
    </span>
  ) : (
    <EnvironmentMachineIcon aria-hidden kind={kind} className={className} />
  );
}
