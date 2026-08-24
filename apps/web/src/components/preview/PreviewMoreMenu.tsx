"use client";

import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useI18n } from "~/i18n";

import { previewBridge } from "./previewBridge";

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /**
   * True only after the desktop bridge has registered a `webContentsId` for
   * the active tab. Tab-targeting actions throw on the desktop side until
   * then; we disable those items so the menu doesn't fire silent no-ops.
   */
  hasWebContents: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** Emulated `prefers-color-scheme` for the guest page. */
  colorScheme: DesktopPreviewColorScheme;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  /** Whether the separate native always-on-top preview window is open. */
  nativePictureInPicture: boolean;
  /** Toggles the optional native always-on-top preview window. */
  onNativePictureInPicture: () => void;
}

/**
 * Three-dot menu in the chrome row. Wires Hard reload, DevTools, zoom
 * controls, and storage-clearing actions. Only mounted by `PreviewView`
 * when the desktop bridge is present, so we can call it unconditionally.
 */
export function PreviewMoreMenu({
  tabId,
  hasWebContents,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  onNativePictureInPicture,
}: Props) {
  const { t } = useI18n();
  if (!previewBridge) return null;
  const bridge = previewBridge;
  const tabDisabled = !tabId || !hasWebContents;
  const callTab = (op: (tabId: string) => Promise<void>) => () => {
    if (!tabId) return;
    void op(tabId).catch(() => undefined);
  };

  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={t("preview.menu")}
                />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>{t("preview.more")}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuItem onClick={callTab(bridge.hardReload)} disabled={tabDisabled}>
          {t("preview.hardReload")}
        </MenuItem>
        <MenuItem onClick={callTab(bridge.openDevTools)} disabled={tabDisabled}>
          {t("preview.openDevTools")}
        </MenuItem>
        <MenuItem onClick={onNativePictureInPicture} disabled={tabDisabled}>
          {nativePictureInPicture
            ? t("preview.closeSeparateWindow")
            : t("preview.openSeparateWindow")}
        </MenuItem>
        <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
          {deviceToolbarVisible ? t("preview.hideDeviceToolbar") : t("preview.showDeviceToolbar")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={tabDisabled}>{t("settings.nav.appearance")}</MenuSubTrigger>
          <MenuSubPopup className="min-w-32">
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => {
                if (!tabId) return;
                void bridge
                  .setColorScheme(tabId, value as DesktopPreviewColorScheme)
                  .catch(() => undefined);
              }}
            >
              {(
                [
                  { value: "system", label: t("settings.theme.system") },
                  { value: "light", label: t("settings.theme.light") },
                  { value: "dark", label: t("settings.theme.dark") },
                ] satisfies ReadonlyArray<{
                  value: DesktopPreviewColorScheme;
                  label: string;
                }>
              ).map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        {/*
          Zoom row: label + inline control cluster. `closeOnClick=false`
          keeps the menu open while the user clicks the +/− buttons.
        */}
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={tabDisabled}
        >
          <span>{t("preview.zoom")}</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.zoomOut)}
              aria-label={t("preview.zoomOut")}
              disabled={tabDisabled}
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
              onClick={callTab(bridge.zoomIn)}
              aria-label={t("preview.zoomIn")}
              disabled={tabDisabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.resetZoom)}
              aria-label={t("preview.resetZoom")}
              className="[:hover,[data-pressed]]:bg-foreground/10"
              disabled={tabDisabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void bridge.clearCookies().catch(() => undefined)}>
          {t("preview.clearCookies")}
        </MenuItem>
        <MenuItem onClick={() => void bridge.clearCache().catch(() => undefined)}>
          {t("preview.clearCache")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
