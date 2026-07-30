import type {
  FormaInteractionMode,
  ServerProviderSupportedInteractionMode,
} from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  CirclePlusIcon,
  ImageIcon,
  MessageCircleQuestionIcon,
  SparklesIcon,
} from "lucide-react";
import { memo } from "react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

const modeOptions = [
  { id: "default", label: "Build", Icon: BotIcon },
  { id: "ask", label: "Ask", Icon: MessageCircleQuestionIcon },
  { id: "plan", label: "Plan", Icon: SparklesIcon },
] as const;

export const ComposerAddActionsMenu = memo(function ComposerAddActionsMenu(props: {
  readonly interactionMode: FormaInteractionMode;
  readonly supportedInteractionModes: ReadonlyArray<ServerProviderSupportedInteractionMode>;
  readonly showInteractionModeActions: boolean;
  readonly imageDisabled: boolean;
  readonly skillDisabled: boolean;
  readonly onSelectMode: (mode: FormaInteractionMode) => void;
  readonly onSelectImage: () => void;
  readonly onSelectSkill: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            aria-label="Add composer action"
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/75 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60"
            data-composer-add-actions-trigger="true"
            type="button"
          />
        }
      >
        <CirclePlusIcon className="size-5" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-56">
        {props.showInteractionModeActions
          ? modeOptions.map(({ id, label, Icon }) =>
              id === "ask" && !props.supportedInteractionModes.includes("ask") ? null : (
                <MenuItem
                  className="gap-3"
                  disabled={props.interactionMode === id}
                  key={id}
                  onClick={() => props.onSelectMode(id)}
                >
                  <Icon className="size-4" />
                  <span className="font-medium">{label}</span>
                  {props.interactionMode === id ? <CheckIcon className="ml-auto size-3" /> : null}
                </MenuItem>
              ),
            )
          : null}
        {props.showInteractionModeActions ? <MenuSeparator /> : null}
        <MenuItem className="gap-3" disabled={props.imageDisabled} onClick={props.onSelectImage}>
          <ImageIcon className="size-4" />
          <span className="font-medium">Image</span>
        </MenuItem>
        <MenuItem className="gap-3" disabled={props.skillDisabled} onClick={props.onSelectSkill}>
          <SparklesIcon className="size-4" />
          <span className="font-medium">Skill</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
