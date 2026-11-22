import Constants from "expo-constants";

import { buildFontCssVariables, resolveBuildFontFamilies } from "./easydevFonts";

const IS_STANDALONE_BUILD = Constants.expoConfig?.extra?.standalone === true;

export const FONT_FAMILIES = resolveBuildFontFamilies(IS_STANDALONE_BUILD);
export const FONT_CSS_VARIABLES = buildFontCssVariables(IS_STANDALONE_BUILD);
