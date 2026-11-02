import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { useT } from "~/hooks/useI18n";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: MessageKey;
}> = [
  { value: "system", label: "review.preview.menu.system" },
  { value: "light", label: "review.preview.menu.light" },
  { value: "dark", label: "review.preview.menu.dark" },
];

export interface PreviewMoreMenuActions {
  readonly hardReload: () => void;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearCookies: () => void;
  readonly clearCache: () => void;
  readonly openDevTools?: () => void;
  readonly toggleNativePictureInPicture?: () => void;
}

interface Props {
  enabled: boolean;
  actions: PreviewMoreMenuActions;
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  deviceToolbarVisible: boolean;
  onToggleDeviceToolbar: () => void;
  nativePictureInPicture: boolean;
  profileName: string | undefined;
  move?: { readonly label: string; readonly onMove: () => void };
}

const MenuTriggerButton = () => {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={t("review.preview.menu.aria")}
              />
            }
          />
        }
      >
        <MoreVertical />
      </TooltipTrigger>
      <TooltipPopup>{t("review.preview.menu.more")}</TooltipPopup>
    </Tooltip>
  );
};

export function PreviewMoreMenu({
  enabled,
  actions,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  profileName,
  move,
}: Props) {
  const t = useT();
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  return (
    <Menu>
      <MenuTriggerButton />
      <MenuPopup align="end" sideOffset={6}>
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          {t("review.preview.menu.hardReload")}
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            {t("review.preview.menu.openDevTools")}
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? t("review.preview.menu.closeSeparateWindow")
              : t("review.preview.menu.openSeparateWindow")}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible
            ? t("review.preview.menu.hideDeviceToolbar")
            : t("review.preview.menu.showDeviceToolbar")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>{t("review.preview.menu.appearance")}</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => actions.setColorScheme(value as DesktopPreviewColorScheme)}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {t(option.label)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={disabled}
        >
          <span>{t("review.preview.menu.zoom")}</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomOut}
              aria-label={t("review.preview.menu.zoomOut")}
              disabled={disabled}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomIn}
              aria-label={t("review.preview.menu.zoomIn")}
              disabled={disabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={actions.resetZoom}
              aria-label={t("review.preview.menu.resetZoom")}
              disabled={disabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          {profileName ? (
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">
                {t("review.preview.menu.profile", { name: profileName })}
              </span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>
            {t("review.preview.menu.clearCookies")}
          </MenuItem>
          <MenuItem onClick={actions.clearCache}>{t("review.preview.menu.clearCache")}</MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
