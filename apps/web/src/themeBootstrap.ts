import { readBrowserClientSettings } from "./clientPersistenceStorage";
import { applyAppIconPreferenceToDocument } from "./appIcon";
import { applyInterfaceSettingsToDocument } from "./interfaceAppearance";
import { DEFAULT_APP_ICON_ID } from "@forma/contracts/settings";
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
applyAppIconPreferenceToDocument(clientSettings ?? { appIcon: DEFAULT_APP_ICON_ID }, document);
if (clientSettings) {
  applyInterfaceSettingsToDocument(clientSettings, document);
}
