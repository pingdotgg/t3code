/**
 * Shared import for the app-wide appearance hook. The implementation lives
 * beside the preference provider so it cannot accidentally fall back to the
 * OS-only React Native hook.
 */
export { useAppearanceColorScheme } from "../features/settings/appearance/AppearancePreferencesProvider";
