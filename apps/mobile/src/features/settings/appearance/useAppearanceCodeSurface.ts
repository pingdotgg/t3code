import { useMemo } from "react";

import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../../lib/appearancePreferences";
import { createNativeReviewDiffStyle } from "../../review/nativeReviewDiffAdapter";
import { createNativeSourceStyle } from "../../files/nativeSourceFileAdapter";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export function useAppearanceCodeSurface(): {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly codeWordBreak: boolean;
  readonly monoFontFamily: string;
  readonly nativeSourceStyle: ReturnType<typeof createNativeSourceStyle>;
  readonly nativeReviewDiffStyle: ReturnType<typeof createNativeReviewDiffStyle>;
} {
  const { appearance, fontFamilies, monoFontFamily } = useAppearancePreferences();
  const uiFontFamily = fontFamilies.regular;
  const uiBoldFontFamily = fontFamilies.bold;
  const codeSurface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize),
    [appearance.codeFontSize],
  );
  const nativeSourceStyle = useMemo(
    () =>
      createNativeSourceStyle(codeSurface, {
        code: monoFontFamily,
        ui: uiFontFamily,
        uiBold: uiBoldFontFamily,
      }),
    [codeSurface, monoFontFamily, uiBoldFontFamily, uiFontFamily],
  );
  const nativeReviewDiffStyle = useMemo(
    () =>
      createNativeReviewDiffStyle(codeSurface, appearance.codeWordBreak, {
        code: monoFontFamily,
        ui: uiFontFamily,
        uiBold: uiBoldFontFamily,
      }),
    [appearance.codeWordBreak, codeSurface, monoFontFamily, uiBoldFontFamily, uiFontFamily],
  );

  return {
    codeSurface,
    codeWordBreak: appearance.codeWordBreak,
    monoFontFamily,
    nativeSourceStyle,
    nativeReviewDiffStyle,
  };
}
