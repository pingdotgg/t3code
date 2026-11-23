import {
  sameRequestTags,
  type RequestTagFieldsResult,
} from "@t3tools/client-runtime/request-tag-fields";
import { parseLiteLLMRequestTags } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";
import type { LiteLLMDefaultRequestTag } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import { memo, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { RequestTagFields } from "./RequestTagFields";

/** LiteLLM request tags for the thread, edited by category and committed on close. */
export const ComposerRequestTags = memo(function ComposerRequestTags(props: {
  value: string;
  driver: string;
  defaultTag: LiteLLMDefaultRequestTag;
  size?: "sm" | "xs";
  onCommit: (text: string) => void;
}) {
  const gt = useGT();
  const size = props.size ?? "sm";
  const floatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<RequestTagFieldsResult | null>(null);
  const count = parseLiteLLMRequestTags(props.value).length;
  const tooltip =
    count > 0 ? gt("LiteLLM tags: {tags}", { tags: props.value }) : gt("Add LiteLLM tags");

  const close = () => {
    if (edit && !edit.error && !sameRequestTags(edit.tags, parseLiteLLMRequestTags(props.value)))
      props.onCommit(edit.tags.join(", "));
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) {
          setEdit(null);
          setOpen(true);
        } else if (!edit?.error || details.reason === "escape-key") close();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<ComposerControl size={size} aria-label={gt("LiteLLM tags")} />}
            />
          }
        >
          <ComposerControlIcon icon={TagIcon} size={size} />
          <span data-composer-control-label className={count > 0 ? "tabular-nums" : "sr-only"}>
            {count > 0 ? count : gt("Tags")}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" side="top" width="sm" padding="compact" {...floatingLayerProps}>
        <div className="flex flex-col gap-2">
          <RequestTagFields
            value={props.value}
            driver={props.driver}
            defaultTag={props.defaultTag}
            onChange={setEdit}
            onSubmit={() => {
              if (!edit?.error) close();
            }}
          />
          <p className="text-muted-foreground text-xs">
            {gt("Track spend by tag in LiteLLM. All fields are optional.")}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
