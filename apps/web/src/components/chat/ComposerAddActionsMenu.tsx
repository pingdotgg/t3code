import type { ProviderInteractionMode } from "@forma/contracts";
import { memo } from "react";
import {
  IconCheckmark as CheckIcon,
  IconCubeTransparent as SkillIcon,
  IconPlusCircleFill as PlusCircleIcon,
} from "symbols-react";

import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { composerInteractionModeConfig } from "./composerInteractionMode";

const ImageUploadIcon = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("fill-current", className)}
    fill="currentColor"
    focusable="false"
    viewBox="0 0 16 16"
  >
    <path d="M12.6429 7.69048L8.92925 11.4041C7.48164 12.8517 5.34347 13.0101 4.16667 11.8333C2.98733 10.654 3.14447 8.52219 4.59216 7.07451L8.00206 3.66461C8.93557 2.73109 10.2976 2.63095 11.0333 3.36667C11.7681 4.10139 11.6658 5.4675 10.7361 6.39727L7.32363 9.8097C6.90202 10.2313 6.32171 10.2741 6.02381 9.97619C5.72651 9.6789 5.76949 9.09718 6.1989 8.66776L9.29048 5.57619C9.56662 5.30005 9.56662 4.85233 9.29048 4.57619C9.01433 4.30005 8.56662 4.30005 8.29048 4.57619L5.1989 7.66776C4.24737 8.6193 4.13865 10.091 5.02381 10.9762C5.9095 11.8619 7.37984 11.7535 8.32363 10.8097L11.7361 7.39727C13.1876 5.94573 13.3564 3.68975 12.0333 2.36667C10.7099 1.04326 8.45782 1.20884 7.00206 2.66461L3.59216 6.07451C1.62229 8.04437 1.39955 11.0662 3.16667 12.8333C4.93146 14.5981 7.9596 14.3737 9.92925 12.4041L13.6429 8.69048C13.919 8.41433 13.919 7.96662 13.6429 7.69048C13.3667 7.41433 12.919 7.41433 12.6429 7.69048Z" />
  </svg>
);

const modeMenuOrder = [
  "default",
  "plan",
  "ask",
] as const satisfies ReadonlyArray<ProviderInteractionMode>;

export const ComposerAddActionsMenu = memo(function ComposerAddActionsMenu(props: {
  interactionMode: ProviderInteractionMode;
  showInteractionModeActions: boolean;
  hasEnabledSkills: boolean;
  skillsLoading: boolean;
  imageDisabled: boolean;
  onSelectMode: (mode: ProviderInteractionMode) => void;
  onSelectImage: () => void;
  onSelectSkill: () => void;
}) {
  const skillDisabled = !props.skillsLoading && !props.hasEnabledSkills;
  const showSeparatorBeforeActions = props.showInteractionModeActions;

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-muted-foreground/72 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60",
            )}
            aria-label="Add composer action"
            data-composer-add-actions-trigger="true"
          />
        }
      >
        <PlusCircleIcon className="size-6 fill-current" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-56">
        {props.showInteractionModeActions
          ? modeMenuOrder.map((mode) => {
              const option = composerInteractionModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <MenuItem
                  key={mode}
                  className="gap-3"
                  disabled={props.interactionMode === mode}
                  onClick={() => props.onSelectMode(mode)}
                >
                  <OptionIcon className="size-4 shrink-0 fill-current" />
                  <span className="font-medium text-foreground">{option.label}</span>
                  {props.interactionMode === mode ? (
                    <span className="ml-auto inline-flex items-center text-muted-foreground/72">
                      <CheckIcon className="size-3 fill-current" />
                    </span>
                  ) : null}
                </MenuItem>
              );
            })
          : null}

        {showSeparatorBeforeActions ? <MenuSeparator /> : null}

        <MenuItem className="gap-3" disabled={props.imageDisabled} onClick={props.onSelectImage}>
          <ImageUploadIcon className="size-4 shrink-0 fill-current" />
          <span className="font-medium text-foreground">Image</span>
        </MenuItem>

        <MenuItem className="gap-3" disabled={skillDisabled} onClick={props.onSelectSkill}>
          <SkillIcon className="size-3.5 shrink-0 fill-current" />
          <span className="font-medium text-foreground">Skill</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
