import {
  THEME_MEDIA_QUERY,
  applyThemePreferenceToDocument,
  readStoredThemePreference,
} from "./theme";

const systemDark =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(THEME_MEDIA_QUERY).matches;

applyThemePreferenceToDocument(readStoredThemePreference(), {
  document,
  systemDark,
});
