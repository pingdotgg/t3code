import type { BrowserImportSource, DesktopPreviewColorScheme } from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuShortcut,
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
  label: string;
}> = [
  { value: "system", label: msg("System", { $context: "color scheme" }) },
  { value: "light", label: msg("Light", { $context: "color scheme" }) },
  { value: "dark", label: msg("Dark", { $context: "color scheme" }) },
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
  readonly find?: () => void;
}

export interface PreviewMoreMenuCookieImport {
  readonly sources: ReadonlyArray<BrowserImportSource> | null;
  readonly importableSources: ReadonlyArray<BrowserImportSource>;
  readonly denial?: string | undefined;
  readonly canImport: boolean;
  readonly environmentConnected: boolean;
  readonly onLoadSources: () => void;
  readonly onSelectSource: (source: BrowserImportSource) => void;
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
  findShortcutLabel?: string | null;
  move?: { readonly label: string; readonly onMove: () => void };
  cookieImport?: PreviewMoreMenuCookieImport;
}

const MenuTriggerButton = () => {
  const gt = useGT();
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
                aria-label={gt("Preview menu")}
              />
            }
          />
        }
      >
        <MoreVertical />
      </TooltipTrigger>
      <TooltipPopup>
        <T context="more actions menu">More</T>
      </TooltipPopup>
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
  findShortcutLabel,
  move,
  cookieImport,
}: Props) {
  const gt = useGT();
  const m = useMessages();
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  return (
    <Menu onOpenChange={(open) => open && cookieImport?.onLoadSources()}>
      <MenuTriggerButton />
      <MenuPopup align="end" sideOffset={6}>
        {actions.find ? (
          <MenuItem onClick={actions.find} disabled={disabled}>
            <T>Find on page</T>
            {findShortcutLabel ? <MenuShortcut>{findShortcutLabel}</MenuShortcut> : null}
          </MenuItem>
        ) : null}
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          <T>Hard reload</T>
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            <T>Open DevTools</T>
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? gt("Close separate preview window")
              : gt("Open separate preview window")}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible ? gt("Hide device toolbar") : gt("Show device toolbar")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>
            <T>Appearance</T>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => actions.setColorScheme(value as DesktopPreviewColorScheme)}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {m(option.label)}
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
          <span>
            <T>Zoom</T>
          </span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomOut}
              aria-label={gt("Zoom out")}
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
              aria-label={gt("Zoom in")}
              disabled={disabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={actions.resetZoom}
              aria-label={gt("Reset zoom")}
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
                <T>
                  Profile: <Var>{profileName}</Var>
                </T>
              </span>
            </MenuGroupLabel>
          ) : null}
          {cookieImport ? (
            <MenuSub>
              <MenuSubTrigger>
                <T>Import cookies from</T>
              </MenuSubTrigger>
              <MenuSubPopup>
                {cookieImport.denial !== undefined ? (
                  <MenuItem disabled>{cookieImport.denial}</MenuItem>
                ) : cookieImport.sources === null ? (
                  <MenuItem disabled>
                    <T>Looking for browsers…</T>
                  </MenuItem>
                ) : cookieImport.importableSources.length === 0 ? (
                  <MenuItem disabled>
                    <T>No supported browsers found</T>
                  </MenuItem>
                ) : (
                  <>
                    {cookieImport.importableSources.map((source) => (
                      <MenuItem
                        key={source.id}
                        disabled={!cookieImport.canImport}
                        onClick={() => cookieImport.onSelectSource(source)}
                      >
                        {source.name}
                      </MenuItem>
                    ))}
                    {!cookieImport.environmentConnected ? (
                      <MenuItem disabled>
                        <T>Connect to an environment to import cookies</T>
                      </MenuItem>
                    ) : null}
                  </>
                )}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>
            <T>Clear cookies</T>
          </MenuItem>
          <MenuItem onClick={actions.clearCache}>
            <T>Clear cache</T>
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
