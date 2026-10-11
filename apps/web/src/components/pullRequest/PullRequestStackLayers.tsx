import type { PullRequestRef, PullRequestStack } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { MenuItem, MenuGroupLabel } from "../ui/menu";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";

export function PullRequestStackLayers({
  stack,
  reference,
  onSelect,
  pending = false,
}: {
  stack: PullRequestStack;
  reference: PullRequestRef;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  pending?: boolean;
}) {
  return (
    <div className="max-h-80 overflow-y-auto">
      {stack.layers.toReversed().map((layer) => {
        return (
          <MenuItem
            key={layer.number}
            onClick={() => {
              onSelect?.({ ...reference, number: layer.number });
            }}
            disabled={!onSelect || pending}
            aria-current={layer.number === reference.number ? "true" : undefined}
          >
            <PullRequestStackLayerContent layer={layer} />
            {layer.number === reference.number ? (
              <CheckIcon aria-hidden className="size-3.5" />
            ) : null}
          </MenuItem>
        );
      })}
      <MenuGroupLabel>↳ {stack.base}</MenuGroupLabel>
    </div>
  );
}
