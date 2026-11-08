import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_CHAT_BACKGROUND_OPACITY,
  MIN_CHAT_BACKGROUND_OPACITY,
  type ChatBackgroundEffect,
  type ChatBackgroundScope,
} from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

import {
  removeChatBackgroundImage,
  setChatBackgroundImage,
  useChatBackgroundUrl,
} from "../chatBackground/chatBackgroundStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const EFFECT_LABELS: Record<ChatBackgroundEffect, string> = {
  none: "None",
  dither: "Dither (default)",
  halftone: "Halftone",
  ascii: "ASCII",
  scanlines: "Scanlines",
};

const SCOPE_LABELS: Record<ChatBackgroundScope, string> = {
  empty: "New threads",
  all: "All threads (default)",
};

const reportError = (title: string, error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });

export function ChatBackgroundSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const preview = useChatBackgroundUrl(settings.chatBackgroundEffect, false);
  const opacityRatio =
    (settings.chatBackgroundOpacity - MIN_CHAT_BACKGROUND_OPACITY) /
    (MAX_CHAT_BACKGROUND_OPACITY - MIN_CHAT_BACKGROUND_OPACITY);
  const opacitySliderStyle = {
    "--settings-slider-progress": `${opacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - opacityRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsSection id="appearance-chat-background" title="Chat background">
      <SettingsRow
        {...searchableSetting("chat-background-image")}
        description="Show your own artwork behind the chat. It stays on this device."
        control={
          <div className="flex items-center gap-2">
            {preview ? (
              <img alt="" src={preview} className="h-8 w-12 rounded-md border object-cover" />
            ) : null}
            <Button size="sm" variant="outline" render={<label />}>
              {preview ? "Replace" : "Choose image"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) {
                    setChatBackgroundImage(file).catch((error: unknown) =>
                      reportError("Could not set the chat background", error),
                    );
                  }
                }}
              />
            </Button>
            {preview ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  removeChatBackgroundImage().catch((error: unknown) =>
                    reportError("Could not remove the chat background", error),
                  )
                }
              >
                Remove
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("chat-background-effect")}
        description="Rebuild the artwork as dithered pixels, print dots, characters, or display lines."
        resetAction={
          settings.chatBackgroundEffect !== DEFAULT_UNIFIED_SETTINGS.chatBackgroundEffect ? (
            <SettingResetButton
              label="background effect"
              onClick={() =>
                updateSettings({
                  chatBackgroundEffect: DEFAULT_UNIFIED_SETTINGS.chatBackgroundEffect,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.chatBackgroundEffect}
            onValueChange={(value) => {
              if (value) updateSettings({ chatBackgroundEffect: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-52"
              aria-label="Background effect"
            >
              <SelectValue>{EFFECT_LABELS[settings.chatBackgroundEffect]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(EFFECT_LABELS) as ChatBackgroundEffect[]).map((effect) => (
                <SelectItem key={effect} value={effect}>
                  {EFFECT_LABELS[effect]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("chat-background-scope")}
        description="Show the artwork only while starting a thread, or behind every conversation."
        resetAction={
          settings.chatBackgroundScope !== DEFAULT_UNIFIED_SETTINGS.chatBackgroundScope ? (
            <SettingResetButton
              label="background scope"
              onClick={() =>
                updateSettings({
                  chatBackgroundScope: DEFAULT_UNIFIED_SETTINGS.chatBackgroundScope,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.chatBackgroundScope}
            onValueChange={(value) => {
              if (value) updateSettings({ chatBackgroundScope: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-52"
              aria-label="Show background on"
            >
              <SelectValue>{SCOPE_LABELS[settings.chatBackgroundScope]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="empty">{SCOPE_LABELS.empty}</SelectItem>
              <SelectItem value="all">{SCOPE_LABELS.all}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("chat-background-opacity")}
        description="How strongly the artwork shows through."
        resetAction={
          settings.chatBackgroundOpacity !== DEFAULT_UNIFIED_SETTINGS.chatBackgroundOpacity ? (
            <SettingResetButton
              label="background visibility"
              onClick={() =>
                updateSettings({
                  chatBackgroundOpacity: DEFAULT_UNIFIED_SETTINGS.chatBackgroundOpacity,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="chat-background-opacity"
            >
              {settings.chatBackgroundOpacity}%
            </output>
            <input
              aria-label="Background visibility"
              className="settings-slider min-w-0 flex-1"
              id="chat-background-opacity"
              max={MAX_CHAT_BACKGROUND_OPACITY}
              min={MIN_CHAT_BACKGROUND_OPACITY}
              onChange={(event) => {
                const chatBackgroundOpacity = Number(event.currentTarget.value);
                if (
                  Number.isInteger(chatBackgroundOpacity) &&
                  chatBackgroundOpacity >= MIN_CHAT_BACKGROUND_OPACITY &&
                  chatBackgroundOpacity <= MAX_CHAT_BACKGROUND_OPACITY
                ) {
                  updateSettings({ chatBackgroundOpacity });
                }
              }}
              step={5}
              style={opacitySliderStyle}
              type="range"
              value={settings.chatBackgroundOpacity}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
