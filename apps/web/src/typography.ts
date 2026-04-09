import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ChatTypographyFontSize,
  type CodeTypographyFontSize,
  type FontFamilySetting,
  type UserMessageFontSetting,
  type TypographyLineHeight,
} from "@t3tools/contracts/settings";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { CLIENT_SETTINGS_STORAGE_KEY } from "./settingsStorage";

export type TypographySettings = Pick<
  ClientSettings,
  | "fontFamily"
  | "userMessageFont"
  | "chatFontSize"
  | "chatLineHeight"
  | "codeFontSize"
  | "codeLineHeight"
>;

export const DEFAULT_TYPOGRAPHY_SETTINGS: TypographySettings = {
  ...pickTypographySettings(DEFAULT_CLIENT_SETTINGS),
};

export const FONT_FAMILY_OPTIONS = [
  { value: "default", label: "DM Sans" },
  { value: "system", label: "System UI" },
] as const satisfies ReadonlyArray<{
  value: FontFamilySetting;
  label: string;
}>;

export const CHAT_TYPOGRAPHY_FONT_SIZE_OPTIONS = [
  { value: "13px", label: "13 px" },
  { value: "14px", label: "14 px" },
  { value: "15px", label: "15 px" },
  { value: "16px", label: "16 px" },
  { value: "17px", label: "17 px" },
  { value: "18px", label: "18 px" },
] as const satisfies ReadonlyArray<{
  value: ChatTypographyFontSize;
  label: string;
}>;

export const CODE_TYPOGRAPHY_FONT_SIZE_OPTIONS = [
  { value: "12px", label: "12 px" },
  { value: "13px", label: "13 px" },
  { value: "14px", label: "14 px" },
  { value: "15px", label: "15 px" },
  { value: "16px", label: "16 px" },
  { value: "17px", label: "17 px" },
  { value: "18px", label: "18 px" },
] as const satisfies ReadonlyArray<{
  value: CodeTypographyFontSize;
  label: string;
}>;

export const TYPOGRAPHY_LINE_HEIGHT_OPTIONS = [
  { value: "1.4", label: "1.4" },
  { value: "1.5", label: "1.5" },
  { value: "1.625", label: "1.625" },
  { value: "1.75", label: "1.75" },
  { value: "1.875", label: "1.875" },
] as const satisfies ReadonlyArray<{
  value: TypographyLineHeight;
  label: string;
}>;

export const USER_MESSAGE_FONT_OPTIONS = [
  { value: "monospace", label: "Monospace" },
  { value: "sans", label: "Sans" },
] as const satisfies ReadonlyArray<{
  value: UserMessageFontSetting;
  label: string;
}>;

const FONT_FAMILY_STACKS: Record<FontFamilySetting, string> = {
  default: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const DEFAULT_CHAT_CHAR_WIDTH_FACTOR = 7.2 / 14;
const SYSTEM_CHAT_CHAR_WIDTH_FACTOR = 7.6 / 14;
const USER_MESSAGE_MONO_CHAR_WIDTH_FACTOR = 8.4 / 14;

const FONT_FAMILY_VALUES = new Set<FontFamilySetting>(
  FONT_FAMILY_OPTIONS.map((option) => option.value),
);
const USER_MESSAGE_FONT_VALUES = new Set<UserMessageFontSetting>(
  USER_MESSAGE_FONT_OPTIONS.map((option) => option.value),
);
const CHAT_FONT_SIZE_VALUES = new Set<ChatTypographyFontSize>(
  CHAT_TYPOGRAPHY_FONT_SIZE_OPTIONS.map((option) => option.value),
);
const CODE_FONT_SIZE_VALUES = new Set<CodeTypographyFontSize>(
  CODE_TYPOGRAPHY_FONT_SIZE_OPTIONS.map((option) => option.value),
);
const LINE_HEIGHT_VALUES = new Set<TypographyLineHeight>(
  TYPOGRAPHY_LINE_HEIGHT_OPTIONS.map((option) => option.value),
);

export function isFontFamilySetting(value: string): value is FontFamilySetting {
  return FONT_FAMILY_VALUES.has(value as FontFamilySetting);
}

export function isUserMessageFontSetting(value: string): value is UserMessageFontSetting {
  return USER_MESSAGE_FONT_VALUES.has(value as UserMessageFontSetting);
}

export function isChatTypographyFontSize(value: string): value is ChatTypographyFontSize {
  return CHAT_FONT_SIZE_VALUES.has(value as ChatTypographyFontSize);
}

export function isCodeTypographyFontSize(value: string): value is CodeTypographyFontSize {
  return CODE_FONT_SIZE_VALUES.has(value as CodeTypographyFontSize);
}

export function isTypographyLineHeight(value: string): value is TypographyLineHeight {
  return LINE_HEIGHT_VALUES.has(value as TypographyLineHeight);
}

export function pickTypographySettings(settings: TypographySettings): TypographySettings {
  return {
    fontFamily: settings.fontFamily,
    userMessageFont: settings.userMessageFont,
    chatFontSize: settings.chatFontSize,
    chatLineHeight: settings.chatLineHeight,
    codeFontSize: settings.codeFontSize,
    codeLineHeight: settings.codeLineHeight,
  };
}

export function buildTypographyCssVariables(
  settings: TypographySettings,
): Readonly<Record<string, string>> {
  const userMessageUsesCodeTypography = settings.userMessageFont === "monospace";

  return {
    "--app-ui-font-family": FONT_FAMILY_STACKS[settings.fontFamily],
    "--app-chat-font-family": FONT_FAMILY_STACKS[settings.fontFamily],
    "--app-user-message-font-family": userMessageUsesCodeTypography
      ? "var(--app-code-font-family)"
      : FONT_FAMILY_STACKS[settings.fontFamily],
    "--app-user-message-font-size": userMessageUsesCodeTypography
      ? settings.codeFontSize
      : settings.chatFontSize,
    "--app-user-message-line-height": userMessageUsesCodeTypography
      ? settings.codeLineHeight
      : settings.chatLineHeight,
    "--app-chat-font-size": settings.chatFontSize,
    "--app-chat-line-height": settings.chatLineHeight,
    "--app-code-font-size": settings.codeFontSize,
    "--app-code-line-height": settings.codeLineHeight,
  };
}

export function resolveTypographyFontSizePx(
  fontSize: ChatTypographyFontSize | CodeTypographyFontSize,
): number {
  return Number.parseFloat(fontSize);
}

export function resolveTypographyLineHeightValue(lineHeight: TypographyLineHeight): number {
  return Number.parseFloat(lineHeight);
}

export function resolveChatAverageCharacterWidthPx(settings: TypographySettings): number {
  const factor =
    settings.fontFamily === "system"
      ? SYSTEM_CHAT_CHAR_WIDTH_FACTOR
      : DEFAULT_CHAT_CHAR_WIDTH_FACTOR;
  return resolveTypographyFontSizePx(settings.chatFontSize) * factor;
}

export function resolveUserMessageFontSizePx(settings: TypographySettings): number {
  return settings.userMessageFont === "monospace"
    ? resolveTypographyFontSizePx(settings.codeFontSize)
    : resolveTypographyFontSizePx(settings.chatFontSize);
}

export function resolveUserMessageLineHeightValue(settings: TypographySettings): number {
  return resolveTypographyLineHeightValue(
    settings.userMessageFont === "monospace" ? settings.codeLineHeight : settings.chatLineHeight,
  );
}

export function resolveUserMessageAverageCharacterWidthPx(settings: TypographySettings): number {
  if (settings.userMessageFont === "monospace") {
    return resolveUserMessageFontSizePx(settings) * USER_MESSAGE_MONO_CHAR_WIDTH_FACTOR;
  }

  return resolveChatAverageCharacterWidthPx(settings);
}

export function applyTypographySettings(
  target: HTMLElement | null | undefined,
  settings: TypographySettings,
): void {
  if (!target) {
    return;
  }

  for (const [name, value] of Object.entries(buildTypographyCssVariables(settings))) {
    target.style.setProperty(name, value);
  }
}

export function applyStoredTypographySettings(): void {
  if (typeof document === "undefined") {
    return;
  }

  try {
    const storedSettings =
      getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema) ??
      DEFAULT_CLIENT_SETTINGS;
    applyTypographySettings(document.documentElement, pickTypographySettings(storedSettings));
  } catch {
    applyTypographySettings(document.documentElement, DEFAULT_TYPOGRAPHY_SETTINGS);
  }
}
