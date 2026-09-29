import { translate } from "@t3tools/i18n";
("use client");

import type { DesktopPreviewColorScheme, EnvironmentId } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

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

import { previewBridge } from "./previewBridge";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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
  /** Environment the tab belongs to; scopes storage clearing to its partitions. */
  environmentId: EnvironmentId;
  /** Profile the tab was opened under, if the server recorded one. */
  /**
   * Required: the IPC layer reads an absent profile as "every profile", so a
   * tab whose own profile is unknown must resolve the default before it gets
   * here rather than passing the gap along.
   */
  profileId: string;
  /** Profile display name, shown so the menu says which data is being cleared. */
  profileName: string | undefined;
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
  environmentId,
  profileId,
  profileName,
}: Props) {
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
                  aria-label={translate("chatView:previewMenu", "Preview menu")}
                />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>{translate("chatView:previewMore", "More")}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6}>
        <MenuItem onClick={callTab(bridge.hardReload)} disabled={tabDisabled}>
          {translate("chatView:hardReload", "Hard reload")}
        </MenuItem>
        <MenuItem onClick={callTab(bridge.openDevTools)} disabled={tabDisabled}>
          {translate("common:uiOpenDevTools", "Open DevTools")}
        </MenuItem>
        <MenuItem onClick={onNativePictureInPicture} disabled={tabDisabled}>
          {nativePictureInPicture
            ? translate("common:uiCloseSeparatePreviewWindow", "Close separate preview window")
            : translate("common:uiOpenSeparatePreviewWindow", "Open separate preview window")}
        </MenuItem>
        <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
          {deviceToolbarVisible
            ? translate("common:uiHideDeviceToolbar", "Hide device toolbar")
            : translate("common:uiShowDeviceToolbar", "Show device toolbar")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={tabDisabled}>
            {translate("chatView:previewAppearance", "Appearance")}
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => {
                if (!tabId) return;
                void bridge
                  .setColorScheme(tabId, value as DesktopPreviewColorScheme)
                  .catch(() => undefined);
              }}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
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
          <span>{translate("chatView:previewZoom", "Zoom")}</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.zoomOut)}
              aria-label={translate("chatView:zoomOut", "Zoom out")}
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
              aria-label={translate("chatView:zoomIn", "Zoom in")}
              disabled={tabDisabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.resetZoom)}
              aria-label={translate("chatView:resetZoom", "Reset zoom")}
              disabled={tabDisabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        {/*
          Grouped so the heading has a `MenuGroup` ancestor — `MenuGroupLabel`
          reads its context and throws without one. The heading also answers
          which profile the tab is in, which is otherwise invisible: it is fixed
          at open and nothing else in the chrome shows it.
        */}
        <MenuGroup>
          {/*
            The heading carries the profile so the actions below can keep
            fixed-length labels: repeating a name of up to 48 characters in
            each one drove the popup far past its width.
          */}
          {profileName ? (
            // Truncation needs a block box: `text-overflow` on an inline child
            // never applies and a long name would push the popup past its width.
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">
                {translate("common:uiProfileName", "Profile: {{name}}", { name: profileName })}
              </span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem
            onClick={() =>
              void bridge.clearCookies(environmentId, profileId).catch(() => undefined)
            }
          >
            {translate("chatView:clearCookies", "Clear cookies")}
          </MenuItem>
          <MenuItem
            onClick={() => void bridge.clearCache(environmentId, profileId).catch(() => undefined)}
          >
            {translate("chatView:clearCache", "Clear cache")}
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
