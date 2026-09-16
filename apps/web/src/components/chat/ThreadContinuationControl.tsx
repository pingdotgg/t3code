import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { ThreadContinuationIntent } from "@t3tools/client-runtime/thread-continuation";
import { ArrowRightLeftIcon, MessagesSquareIcon } from "lucide-react";
import { useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ModelPickerContent } from "./ModelPickerContent";
import type { ModelEsque } from "./providerIconUtils";

export interface ThreadContinuationPicker {
  activeModelSelection: ModelSelection;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  disabled?: boolean;
  onSelect: (intent: ThreadContinuationIntent, modelSelection: ModelSelection) => void;
}

export function ThreadContinuationControl({ picker }: { picker: ThreadContinuationPicker }) {
  return (
    <>
      <ThreadContinuationAction picker={picker} intent="handoff" />
      <ThreadContinuationAction picker={picker} intent="second-opinion" />
    </>
  );
}

function ThreadContinuationAction({
  picker,
  intent,
}: {
  picker: ThreadContinuationPicker;
  intent: ThreadContinuationIntent;
}) {
  const [open, setOpen] = useState(false);
  const label = intent === "handoff" ? "Hand off" : "Second opinion";
  const Icon = intent === "handoff" ? ArrowRightLeftIcon : MessagesSquareIcon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
                  aria-label={label}
                  disabled={picker.disabled}
                  data-toolbar-control=""
                />
              }
            />
          }
        >
          <Icon className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        className="before:hidden [--viewport-inline-padding:0]"
        viewportClassName="overflow-hidden! rounded-[calc(var(--radius-lg)-1px)] p-0 [clip-path:inset(0_round_calc(var(--radius-lg)-1px))]"
      >
        <ModelPickerContent
          activeInstanceId={picker.activeModelSelection.instanceId}
          model={picker.activeModelSelection.model}
          lockedProvider={null}
          lockedContinuationGroupKey={null}
          instanceEntries={picker.instanceEntries}
          modelOptionsByInstance={picker.modelOptionsByInstance}
          terminalOpen={false}
          onRequestClose={() => setOpen(false)}
          onInstanceModelChange={(instanceId, model) => {
            setOpen(false);
            picker.onSelect(intent, { instanceId, model });
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}
