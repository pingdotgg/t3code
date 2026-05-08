import { readBrowserClientSettings } from "./clientPersistenceStorage";
import { applyAppIconPreferenceToDocument } from "./appIcon";
import { applyInterfaceSettingsToDocument } from "./interfaceAppearance";
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

const clientSettings = readBrowserClientSettings();
if (clientSettings) {
  applyAppIconPreferenceToDocument(clientSettings, document);
  applyInterfaceSettingsToDocument(clientSettings, document);
}
