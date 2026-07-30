// Applies the persisted Forma theme and interface appearance before React
// mounts so the first paint already matches the user's preferences.
//
// The fork also applied the app-icon preference here; that feature has not
// been re-ported yet, so it is intentionally omitted.
import {
  applyInterfaceSettingsToDocument,
  readStoredInterfaceAppearanceSettings,
} from "./interfaceAppearance";
import {
  THEME_MEDIA_QUERY,
  applyThemePreferenceToDocument,
  readStoredThemeSettings,
} from "./theme";

const systemDark =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(THEME_MEDIA_QUERY).matches;

applyThemePreferenceToDocument(readStoredThemeSettings(), {
  document,
  systemDark,
});

applyInterfaceSettingsToDocument(readStoredInterfaceAppearanceSettings(), document);
