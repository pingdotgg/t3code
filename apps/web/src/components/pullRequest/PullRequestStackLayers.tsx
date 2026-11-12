import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestRef, PullRequestStack } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { RelativeTime } from "~/components/RelativeTime";
import { MenuItem, MenuGroupLabel, MenuSeparator } from "../ui/menu";
import { MENU_ROW_TEXT_CLASS } from "../ui/menu-row-text";
import { ScrollArea } from "../ui/scroll-area";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";

/** The stack's layers, top first for navigation, then when it was last synced. */
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
      <ScrollArea
        orientation="vertical"
        scrollFade
        className="h-auto max-h-[min(24rem,calc(var(--available-height)-12rem))]"
      >
        <div className="py-1">
          {stack.layers.toReversed().map((layer, index) => {
            const current = layer.number === reference.number;
            return (
              <MenuItem
                key={layer.number}
                onClick={() => {
                  onSelect?.({ ...reference, number: layer.number });
                }}
                disabled={!onSelect || pending}
                selected={current}
                aria-current={current ? "true" : undefined}
              >
                <PullRequestStackLayerContent
                  layer={layer}
                  terminology={terminology}
                  position={stack.layers.length - index}
                  size={stack.layers.length}
                  base={stack.base}
                  current={current}
                />
              </MenuItem>
            );
          })}
        </div>
      </ScrollArea>
      <MenuGroupLabel>
        <span className="pl-6 font-mono text-meta">{stack.base}</span>
      </MenuGroupLabel>
      {syncedAt !== undefined && syncedAt > 0 ? (
        <>
          <MenuSeparator />
          <MenuGroupLabel>
            <span className={`flex items-center gap-2 ${MENU_ROW_TEXT_CLASS}`}>
              <RefreshCwIcon aria-hidden className="size-4 shrink-0" />
              <span>
                Synced <RelativeTime timestamp={new Date(syncedAt).toISOString()} />
              </span>
            </span>
          </MenuGroupLabel>
        </>
      ) : null}
    </>
  );
}
