import type {
  FormaInteractionMode,
  ServerProviderSupportedInteractionMode,
} from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { IconEllipsis as EllipsisIcon } from "symbols-react";
import { Button } from "../ui/button";
import { SidebarPlanReadyIcon } from "../icons/custom";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { composerInteractionModeConfig } from "./composerInteractionMode";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: FormaInteractionMode;
  supportedInteractionModes: ReadonlyArray<ServerProviderSupportedInteractionMode>;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onInteractionModeChange: (mode: FormaInteractionMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const interactionModeDescription =
    composerInteractionModeConfig[props.interactionMode].description;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <div className="px-2 pb-1 text-xs text-muted-foreground/70">
              {interactionModeDescription}
            </div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onInteractionModeChange(value as FormaInteractionMode);
              }}
            >
              <MenuRadioItem value="default">
                {(() => {
                  const Icon = composerInteractionModeConfig.default.icon;
                  return <Icon className="size-3.5 fill-current" />;
                })()}
                Build
              </MenuRadioItem>
              {props.supportedInteractionModes.includes("ask") ? (
                <MenuRadioItem value="ask">
                  {(() => {
                    const Icon = composerInteractionModeConfig.ask.icon;
                    return <Icon className="size-3.5 fill-current" />;
                  })()}
                  Ask
                </MenuRadioItem>
              ) : null}
              <MenuRadioItem value="plan">
                {(() => {
                  const Icon = composerInteractionModeConfig.plan.icon;
                  return <Icon className="size-3.5 fill-current" />;
                })()}
                Plan
              </MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <SidebarPlanReadyIcon className="size-4 shrink-0 fill-current text-violet-600 dark:text-violet-300/90" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
