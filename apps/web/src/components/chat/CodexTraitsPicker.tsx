import { type CodexReasoningEffort } from "@t3tools/contracts";
import { getDefaultReasoningEffort } from "@t3tools/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CodexTraitsPicker = memo(function CodexTraitsPicker(props: {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
  options: ReadonlyArray<CodexReasoningEffort>;
  onEffortChange: (effort: CodexReasoningEffort) => void;
  onFastModeChange: (enabled: boolean) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  const reasoningLabelByOption: Record<CodexReasoningEffort, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
  };
  const effortLabel = reasoningLabelByOption[props.effort];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {props.fastModeEnabled ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <span className="min-w-0 flex-1 truncate">{effortLabel}</span>
              <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">
                ·
              </span>
              <span className="shrink-0">Fast</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{effortLabel}</span>
          )}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
          <MenuRadioGroup
            value={props.effort}
            onValueChange={(value) => {
              if (!value) return;
              const nextEffort = props.options.find((option) => option === value);
              if (!nextEffort) return;
              props.onEffortChange(nextEffort);
            }}
          >
            {props.options.map((effort) => (
              <MenuRadioItem key={effort} value={effort}>
                {reasoningLabelByOption[effort]}
                {effort === defaultReasoningEffort ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
          <MenuRadioGroup
            value={props.fastModeEnabled ? "on" : "off"}
            onValueChange={(value) => {
              props.onFastModeChange(value === "on");
            }}
          >
            <MenuRadioItem value="off">off</MenuRadioItem>
            <MenuRadioItem value="on">on</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
