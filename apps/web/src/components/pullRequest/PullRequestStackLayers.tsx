import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestRef, PullRequestStack } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { RelativeTime } from "~/components/RelativeTime";
import { MenuItem, MenuGroupLabel, MenuSeparator } from "../ui/menu";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";

/** The stack's layers, bottom first as the stack is read, then when it was last synced. */
export function PullRequestStackLayers({
  stack,
  terminology,
  reference,
  onSelect,
  pending = false,
  syncedAt,
}: {
  stack: PullRequestStack;
  terminology: ChangeRequestTerminology;
  reference: PullRequestRef;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  pending?: boolean;
  /** Epoch milliseconds of the last successful stack read, or 0 when it was never read. */
  syncedAt?: number | undefined;
}) {
  return (
    <>
      <div className="max-h-80 overflow-y-auto">
        {stack.layers.map((layer, index) => {
          const current = layer.number === reference.number;
          return (
            <MenuItem
              key={layer.number}
              onClick={() => {
                onSelect?.({ ...reference, number: layer.number });
              }}
              disabled={!onSelect || pending}
              aria-current={current ? "true" : undefined}
            >
              <PullRequestStackLayerContent
                layer={layer}
                terminology={terminology}
                position={index + 1}
                size={stack.layers.length}
                base={stack.base}
                current={current}
              />
            </MenuItem>
          );
        })}
      </div>
      {syncedAt !== undefined && syncedAt > 0 ? (
        <>
          <MenuSeparator />
          <MenuGroupLabel>
            <span className="flex items-center gap-1.5">
              <RefreshCwIcon aria-hidden className="size-3" />
              Synced <RelativeTime timestamp={new Date(syncedAt).toISOString()} />
            </span>
          </MenuGroupLabel>
        </>
      ) : null}
    </>
  );
}
