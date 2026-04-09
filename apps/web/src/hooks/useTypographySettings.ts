import { useMemo } from "react";
import { pickTypographySettings, type TypographySettings } from "../typography";
import { useSettings } from "./useSettings";

export function useTypographySettings(): TypographySettings {
  const settings = useSettings();
  const {
    fontFamily,
    userMessageFont,
    chatFontSize,
    chatLineHeight,
    codeFontSize,
    codeLineHeight,
  } = settings;

  return useMemo(
    () =>
      pickTypographySettings({
        fontFamily,
        userMessageFont,
        chatFontSize,
        chatLineHeight,
        codeFontSize,
        codeLineHeight,
      }),
    [fontFamily, userMessageFont, chatFontSize, chatLineHeight, codeFontSize, codeLineHeight],
  );
}
